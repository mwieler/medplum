import { Filter, SortRule } from '@medplum/core';
import { Resource, SearchParameter } from '@medplum/fhirtypes';
import { Conjunction, SelectQuery } from '../sql';

/**
 * The LookupTable interface is used for search parameters that are indexed in separate tables.
 * This is necessary for array properties with specific structure.
 * Common examples include:
 *   1) Identifiers - arbitrary key/value pairs on many different resource types
 *   2) Human Names - structured names on Patients, Practitioners, and other person resource types
 *   3) Contact Points - email addresses and phone numbers
 */
export interface LookupTable {
  /**
   * Determines if the search parameter is indexed by this index table.
   * @param resourceType The resource type.
   * @param searchParam The search parameter.
   * @param resourceType The resource type.
   * @returns True if the search parameter is indexed.
   */
  isIndexed(resourceType: string, searchParam: SearchParameter): boolean;

  /**
   * Indexes the resource in the lookup table.
   * @param resource The resource to index.
   */
  indexResource(resource: Resource): Promise<void>;

  /**
   * Adds "where" conditions to the select query builder.
   * @param selectQuery The select query builder.
   * @param predicate The conjunction where conditions should be added.
   * @param filter The search filter details.
   */
  addWhere(selectQuery: SelectQuery, predicate: Conjunction, filter: Filter): void;

  /**
   * Adds "order by" clause to the select query builder.
   * @param selectQuery The select query builder.
   * @param sortRule The sort rule details.
   */
  addOrderBy(selectQuery: SelectQuery, sortRule: SortRule): void;

  /**
   * Deletes the resource from the lookup table.
   * @param resource The resource to delete.
   */
  deleteValuesForResource(resource: Resource): Promise<void>;
}
