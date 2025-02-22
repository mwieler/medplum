import {
  badRequest,
  Filter,
  getReferenceString,
  LRUCache,
  normalizeErrorString,
  Operator,
  SearchRequest,
} from '@medplum/core';
import { OperationOutcome, Reference, Resource } from '@medplum/fhirtypes';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import {
  ASTNode,
  ASTVisitor,
  DocumentNode,
  execute,
  ExecutionResult,
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLEnumValueConfigMap,
  GraphQLError,
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLResolveInfo,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  parse,
  specifiedRules,
  validate,
  ValidationContext,
} from 'graphql';
import { JSONSchema4 } from 'json-schema';
import { asyncWrap } from '../../async';
import { getJsonSchemaDefinition, getJsonSchemaResourceTypes } from '../jsonschema';
import { Repository } from '../repo';
import { rewriteAttachments, RewriteMode } from '../rewrite';
import { parseSearchRequest } from '../search';
import { getSearchParameters } from '../structure';
import { sendOutcome } from './../outcomes';

const typeCache: Record<string, GraphQLOutputType | undefined> = {
  base64Binary: GraphQLString,
  boolean: GraphQLBoolean,
  canonical: GraphQLString,
  code: GraphQLString,
  date: GraphQLString,
  dateTime: GraphQLString,
  decimal: GraphQLFloat,
  id: GraphQLID,
  instant: GraphQLString,
  integer: GraphQLFloat,
  markdown: GraphQLString,
  number: GraphQLFloat,
  positiveInt: GraphQLFloat,
  string: GraphQLString,
  time: GraphQLString,
  unsignedInt: GraphQLFloat,
  uri: GraphQLString,
  url: GraphQLString,
  xhtml: GraphQLString,
};

/**
 * Cache of "introspection" query results.
 * Common case is the standard schema query from GraphiQL and Insomnia.
 * The result is big and somewhat computationally expensive.
 */
const introspectionResults = new LRUCache<ExecutionResult>();

/**
 * Cached GraphQL schema.
 * This should be initialized at server startup.
 */
let rootSchema: GraphQLSchema | undefined;

/**
 * Handles FHIR GraphQL requests.
 *
 * See: https://www.hl7.org/fhir/graphql.html
 */
export const graphqlHandler = asyncWrap(async (req: Request, res: Response) => {
  const { query, operationName, variables } = req.body;
  if (!query) {
    sendOutcome(res, badRequest('Must provide query.'));
    return;
  }

  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (err) {
    sendOutcome(res, badRequest('GraphQL syntax error.'));
    return;
  }

  const schema = getRootSchema();
  const validationRules = [...specifiedRules, MaxDepthRule];
  const validationErrors = validate(schema, document, validationRules);
  if (validationErrors.length > 0) {
    sendOutcome(res, invalidRequest(validationErrors));
    return;
  }

  try {
    const introspection = isIntrospectionQuery(query);
    let result = introspection && introspectionResults.get(query);
    if (!result) {
      result = await execute({
        schema,
        document,
        contextValue: { res },
        operationName,
        variableValues: variables,
      });
    }

    if (introspection) {
      introspectionResults.set(query, result);
      res.set('Cache-Control', 'public, max-age=31536000');
    } else {
      const repo = res.locals.repo as Repository;
      result = await rewriteAttachments(RewriteMode.PRESIGNED_URL, repo, result);
    }

    const status = result.data ? 200 : 400;
    res.status(status).json(result);
  } catch (err) {
    console.log('Unhandled graphql error', err);
    res.sendStatus(500);
  }
});

/**
 * Returns true if the query is a GraphQL introspection query.
 *
 * Introspection queries ask for the schema, which is expensive.
 *
 * See: https://graphql.org/learn/introspection/
 *
 * @param query The GraphQL query.
 * @returns True if the query is an introspection query.
 */
function isIntrospectionQuery(query: string): boolean {
  return query.includes('query IntrospectionQuery') || query.includes('__schema') || query.includes('__type');
}

export function getRootSchema(): GraphQLSchema {
  if (!rootSchema) {
    rootSchema = buildRootSchema();
  }
  return rootSchema;
}

function buildRootSchema(): GraphQLSchema {
  // First, create placeholder types
  // We need this first for circular dependencies
  for (const resourceType of getJsonSchemaResourceTypes()) {
    const graphQLType = buildGraphQLType(resourceType);
    if (graphQLType) {
      typeCache[resourceType] = graphQLType;
    }
  }

  // Next, fill in all of the type properties
  const fields: GraphQLFieldConfigMap<any, any> = {};
  for (const resourceType of getJsonSchemaResourceTypes()) {
    const graphQLType = getGraphQLType(resourceType);

    // Get resource by ID
    fields[resourceType] = {
      type: graphQLType,
      args: {
        id: {
          type: new GraphQLNonNull(GraphQLID),
          description: resourceType + ' ID',
        },
      },
      resolve: resolveById,
    };

    // Search resource by search parameters
    fields[resourceType + 'List'] = {
      type: new GraphQLList(graphQLType),
      args: buildSearchArgs(resourceType),
      resolve: resolveBySearch,
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'QueryType',
      fields,
    }),
  });
}

function getGraphQLType(resourceType: string): GraphQLOutputType {
  let result = typeCache[resourceType];
  if (!result) {
    result = buildGraphQLType(resourceType);
    if (result) {
      typeCache[resourceType] = result;
    }
  }

  return result;
}

function buildGraphQLType(resourceType: string): GraphQLOutputType {
  if (resourceType === 'ResourceList') {
    return new GraphQLUnionType({
      name: 'ResourceList',
      types: () =>
        getJsonSchemaResourceTypes()
          .map(getGraphQLType)
          .filter((t) => !!t) as GraphQLObjectType[],
      resolveType: resolveTypeByReference,
    });
  }

  const schema = getJsonSchemaDefinition(resourceType);
  return new GraphQLObjectType({
    name: resourceType,
    description: schema.description,
    fields: () => buildGraphQLFields(resourceType),
  });
}

function buildGraphQLFields(resourceType: string): GraphQLFieldConfigMap<any, any> {
  const fields: GraphQLFieldConfigMap<any, any> = {};
  buildPropertyFields(resourceType, fields);
  buildReverseLookupFields(resourceType, fields);
  return fields;
}

function buildPropertyFields(resourceType: string, fields: GraphQLFieldConfigMap<any, any>): void {
  const schema = getJsonSchemaDefinition(resourceType);
  const properties = schema.properties as { [k: string]: JSONSchema4 };

  for (const [propertyName, property] of Object.entries(properties)) {
    const propertyType = getPropertyType(resourceType, property);
    const fieldConfig: GraphQLFieldConfig<any, any> = {
      type: propertyType,
      description: property.description,
    };

    if (resourceType === 'Reference' && propertyName === 'resource') {
      fieldConfig.resolve = resolveByReference;
    }

    fields[propertyName] = fieldConfig;
  }
}

/**
 * Builds a list of reverse lookup fields for a resource type.
 *
 * It's also possible to use search is a special mode, doing reverse lookups -
 * e.g. list all the resources that refer to this resource.
 *
 * An example of this use is to look up a patient,
 * and also retrieve all the Condition resources for the patient.
 *
 * This is a special case of search, above, but with an additional mandatory parameter _reference. For example:
 *
 * {
 *   name { [some fields] }
 *   ConditionList(_reference: patient) {
 *     [some fields from Condition]
 *   }
 * }
 *
 * There must be at least the argument "_reference" which identifies which of the search parameters
 * for the target resource is used to match the resource that has focus.
 * In addition, there may be other arguments as defined above in search
 * (except that the "id" argument is prohibited here as nonsensical).
 *
 * See: https://www.hl7.org/fhir/graphql.html#reverse
 *
 * @param resourceType The resource type to build fields for.
 * @param fields The fields object to add fields to.
 */
function buildReverseLookupFields(resourceType: string, fields: GraphQLFieldConfigMap<any, any>): void {
  for (const childResourceType of getJsonSchemaResourceTypes()) {
    const childGraphQLType = getGraphQLType(childResourceType);
    const childSearchParams = getSearchParameters(childResourceType);
    const enumValues: GraphQLEnumValueConfigMap = {};
    let count = 0;
    if (childSearchParams) {
      for (const [code, searchParam] of Object.entries(childSearchParams)) {
        if (searchParam.target && searchParam.target.includes(resourceType)) {
          enumValues[fhirParamToGraphQLField(code)] = { value: code };
          count++;
        }
      }
    }

    if (count > 0) {
      const enumType = new GraphQLEnumType({
        name: resourceType + '_' + childResourceType + '_reference',
        values: enumValues,
      });
      const args = buildSearchArgs(childResourceType);
      args['_reference'] = {
        type: new GraphQLNonNull(enumType),
        description: `Specify which property to use for reverse lookup for ${childResourceType}`,
      };
      fields[childResourceType + 'List'] = {
        type: new GraphQLList(childGraphQLType),
        args,
        resolve: resolveBySearch,
      };
    }
  }
}

function buildSearchArgs(resourceType: string): GraphQLFieldConfigArgumentMap {
  const args: GraphQLFieldConfigArgumentMap = {
    _count: {
      type: GraphQLInt,
      description: 'Specify how many elements to return from a repeating list.',
    },
    _offset: {
      type: GraphQLInt,
      description: 'Specify the offset to start at for a repeating element.',
    },
    _sort: {
      type: GraphQLString,
      description: 'Specify the sort order by comma-separated list of sort rules in priority order.',
    },
    _id: {
      type: GraphQLString,
      description: 'Select resources based on the logical id of the resource.',
    },
    _lastUpdated: {
      type: GraphQLString,
      description: 'Select resources based on the last time they were changed.',
    },
  };
  const searchParams = getSearchParameters(resourceType);
  if (searchParams) {
    for (const [code, searchParam] of Object.entries(searchParams)) {
      // GraphQL does not support dashes in argument names
      // So convert dashes to underscores
      args[fhirParamToGraphQLField(code)] = {
        type: GraphQLString,
        description: searchParam.description,
      };
    }
  }
  return args;
}

function getPropertyType(parentType: string, property: JSONSchema4): GraphQLOutputType {
  const refStr = getRefString(property);
  if (refStr) {
    return getGraphQLType(refStr);
  }

  const typeStr = property.type;
  if (typeStr) {
    if (typeStr === 'array') {
      return new GraphQLList(getPropertyType(parentType, property.items as JSONSchema4));
    }
    return getGraphQLType(typeStr as string);
  }

  return GraphQLString;
}

function getRefString(property: any): string | undefined {
  if (!('$ref' in property)) {
    return undefined;
  }
  return property.$ref.replace('#/definitions/', '');
}

/**
 * GraphQL data loader for search requests.
 * The field name should always end with "List" (i.e., "Patient" search uses "PatientList").
 * The search args should be FHIR search parameters.
 * @param source The source/root.  This should always be null for our top level readers.
 * @param args The GraphQL search arguments.
 * @param ctx The GraphQL context.  This is the Node IncomingMessage.
 * @param info The GraphQL resolve info.  This includes the schema, and additional field details.
 * @returns Promise to read the resoures for the query.
 * @implements {GraphQLFieldResolver}
 */
async function resolveBySearch(
  source: any,
  args: Record<string, string>,
  ctx: any,
  info: GraphQLResolveInfo
): Promise<Resource[] | undefined> {
  const fieldName = info.fieldName;
  const resourceType = fieldName.substring(0, fieldName.length - 4); // Remove "List"
  const repo = ctx.res.locals.repo as Repository;
  const searchRequest = parseSearchArgs(resourceType, source, args);
  const bundle = await repo.search(searchRequest);
  return bundle.entry?.map((e) => e.resource as Resource);
}

/**
 * GraphQL data loader for ID requests.
 * The field name should always by the resource type.
 * There should always be exactly one argument "id".
 * @param _source The source/root.  This should always be null for our top level readers.
 * @param args The GraphQL search arguments.
 * @param ctx The GraphQL context.  This is the Node IncomingMessage.
 * @param info The GraphQL resolve info.  This includes the schema, and additional field details.
 * @returns Promise to read the resoure for the query.
 * @implements {GraphQLFieldResolver}
 */
async function resolveById(_source: any, args: any, ctx: any, info: GraphQLResolveInfo): Promise<Resource | undefined> {
  const repo = ctx.res.locals.repo as Repository;
  try {
    return await repo.readResource(info.fieldName, args.id);
  } catch (err) {
    throw new Error(normalizeErrorString(err));
  }
}

/**
 * GraphQL data loader for Reference requests.
 * This is a special data loader for following Reference objects.
 * @param source The source/root.  This should always be null for our top level readers.
 * @param _args The GraphQL search arguments.
 * @param ctx The GraphQL context.  This is the Node IncomingMessage.
 * @returns Promise to read the resoure(s) for the query.
 * @implements {GraphQLFieldResolver}
 */
async function resolveByReference(source: any, _args: any, ctx: any): Promise<Resource | undefined> {
  const repo = ctx.res.locals.repo as Repository;
  try {
    return await repo.readReference(source as Reference);
  } catch (err) {
    throw new Error(normalizeErrorString(err));
  }
}

/**
 * GraphQL type resolver for resources.
 * When loading a resource via reference, GraphQL needs to know the type of the resource.
 * @param resource The loaded resource.
 * @returns The GraphQL type of the resource.
 * @implements {GraphQLTypeResolver}
 */
function resolveTypeByReference(resource: Resource | undefined): string | undefined {
  const resourceType = resource?.resourceType;
  if (!resourceType) {
    return undefined;
  }

  return (getGraphQLType(resourceType) as GraphQLObjectType).name;
}

function parseSearchArgs(resourceType: string, source: any, args: Record<string, string>): SearchRequest {
  let referenceFilter: Filter | undefined = undefined;
  if (source) {
    // _reference is a required field for reverse lookup searches
    // The GraphQL parser will validate that it is there.
    const reference = args['_reference'];
    delete args['_reference'];
    referenceFilter = {
      code: reference,
      operator: Operator.EQUALS,
      value: getReferenceString(source as Resource),
    };
  }

  // Reverse the transform of dashes to underscores, back to dashes
  args = Object.fromEntries(Object.entries(args).map(([key, value]) => [graphQLFieldToFhirParam(key), value]));

  // Parse the search request
  const searchRequest = parseSearchRequest(resourceType, args);

  // If a reverse lookup filter was specified,
  // add it to the search request.
  if (referenceFilter) {
    const existingFilters = searchRequest.filters || [];
    searchRequest.filters = [referenceFilter, ...existingFilters];
  }

  return searchRequest;
}

function fhirParamToGraphQLField(code: string): string {
  return code.replaceAll('-', '_');
}

function graphQLFieldToFhirParam(code: string): string {
  return code.startsWith('_') ? code : code.replaceAll('_', '-');
}

/**
 * Custom GraphQL rule that enforces max depth constraint.
 * @param context The validation context.
 * @returns An ASTVisitor that validates the maximum depth rule.
 */
const MaxDepthRule = (context: ValidationContext): ASTVisitor => ({
  Field(
    /** The current node being visiting. */
    node: any,
    /** The index or key to this node from the parent node or Array. */
    _key: string | number | undefined,
    /** The parent immediately above this node, which may be an Array. */
    _parent: ASTNode | ReadonlyArray<ASTNode> | undefined,
    /** The key path to get to this node from the root node. */
    path: ReadonlyArray<string | number>
  ): any {
    const depth = getDepth(path);
    const maxDepth = 8;
    if (depth > maxDepth) {
      const fieldName = node.name.value;
      context.reportError(
        new GraphQLError(`Field "${fieldName}" exceeds max depth (depth=${depth}, max=${maxDepth})`, {
          nodes: node,
        })
      );
    }
  },
});

/**
 * Returns the depth of the GraphQL node in a query.
 * We use "selections" as the representation of depth.
 * As a rough approximation, it's the number of indentations in a well formatted query.
 * @param path The GraphQL node path.
 * @returns The "depth" of the node.
 */
function getDepth(path: ReadonlyArray<string | number>): number {
  return path.filter((p) => p === 'selections').length;
}

/**
 * Returns an OperationOutcome for GraphQL errors.
 * @param errors Array of GraphQL errors.
 * @returns OperationOutcome with the GraphQL errors as OperationOutcome issues.
 */
function invalidRequest(errors: ReadonlyArray<GraphQLError>): OperationOutcome {
  return {
    resourceType: 'OperationOutcome',
    id: randomUUID(),
    issue: errors.map((error) => ({
      severity: 'error',
      code: 'invalid',
      details: { text: error.message },
    })),
  };
}
