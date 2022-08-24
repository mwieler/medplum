import { Filter, Operator as FhirOperator, SortRule } from '@medplum/core';
import { Resource, SearchParameter } from '@medplum/fhirtypes';
import { getClient } from '../../database';
import { Column, Condition, Conjunction, DeleteQuery, Disjunction, InsertQuery, Operator, SelectQuery } from '../sql';
import { LookupTable } from './lookuptable';

/**
 * The DefaultBaseLookupTable class is an abstract implementation of the LookupTable.
 * It provides common helper utilities for descending classes.
 */
export abstract class DefaultBaseLookupTable<T> implements LookupTable {
  /**
   * Returns the unique name of the lookup table.
   * @returns The unique name of the lookup table.
   */
  abstract getTableName(): string;

  /**
   * Returns the column name for the given search parameter.
   * @param code The search parameter code.
   */
  abstract getColumnName(code: string): string;

  /**
   * Determines if the search parameter is indexed by this index table.
   * @param resourceType The resource type.
   * @param searchParam The search parameter.
   */
  abstract isIndexed(resourceType: string, searchParam: SearchParameter): boolean;

  /**
   * Indexes the resource in the lookup table.
   * @param resource The resource to index.
   */
  abstract indexResource(resource: Resource): Promise<void>;

  /**
   * Adds "where" conditions to the select query builder.
   * @param selectQuery The select query builder.
   * @param predicate The conjunction where conditions should be added.
   * @param filter The search filter details.
   */
  addWhere(selectQuery: SelectQuery, predicate: Conjunction, filter: Filter): void {
    const tableName = this.getTableName();
    const joinName = selectQuery.getNextJoinAlias();
    const columnName = this.getColumnName(filter.code);
    const subQuery = new SelectQuery(tableName)
      .raw(`DISTINCT ON ("${tableName}"."resourceId") *`)
      .orderBy('resourceId');
    const disjunction = new Disjunction([]);
    for (const option of filter.value.split(',')) {
      if (filter.operator === FhirOperator.EXACT) {
        disjunction.expressions.push(new Condition(new Column(tableName, columnName), Operator.EQUALS, option?.trim()));
      } else {
        const conjunction = new Conjunction([]);
        for (const chunk of option.split(/\s+/)) {
          conjunction.expressions.push(
            new Condition(new Column(tableName, columnName), Operator.LIKE, `%${chunk.trim()}%`)
          );
        }
        disjunction.expressions.push(conjunction);
      }
    }
    subQuery.whereExpr(disjunction);
    selectQuery.join(joinName, 'id', 'resourceId', subQuery);
    predicate.expressions.push(new Condition(new Column(joinName, columnName), Operator.NOT_EQUALS, null));
  }

  /**
   * Adds "order by" clause to the select query builder.
   * @param selectQuery The select query builder.
   * @param sortRule The sort rule details.
   */
  addOrderBy(selectQuery: SelectQuery, sortRule: SortRule): void {
    const tableName = this.getTableName();
    const joinName = selectQuery.getNextJoinAlias();
    const columnName = this.getColumnName(sortRule.code);
    const subQuery = new SelectQuery(tableName)
      .raw(`DISTINCT ON ("${tableName}"."resourceId") *`)
      .orderBy('resourceId');
    selectQuery.join(joinName, 'id', 'resourceId', subQuery);
    selectQuery.orderBy(new Column(joinName, columnName), sortRule.descending);
  }

  /**
   * Returns the existing list of indexed addresses.
   * @param resourceId The FHIR resource ID.
   * @returns Promise for the list of indexed addresses.
   */
  protected async getExistingValues(resourceId: string): Promise<T[]> {
    const tableName = this.getTableName();
    return new SelectQuery(tableName)
      .column('content')
      .where('resourceId', Operator.EQUALS, resourceId)
      .orderBy('index')
      .execute(getClient())
      .then((result) => result.map((row) => JSON.parse(row.content) as T));
  }

  /**
   * Inserts values into the lookup table for a resource.
   * @param values The values to insert.
   */
  async insertValuesForResource(values: Record<string, any>[]): Promise<void> {
    if (values.length === 0) {
      return;
    }
    const tableName = this.getTableName();
    const client = getClient();
    await new InsertQuery(tableName, values).execute(client);
  }

  /**
   * Deletes the resource from the lookup table.
   * @param resource The resource to delete.
   */
  async deleteValuesForResource(resource: Resource): Promise<void> {
    const tableName = this.getTableName();
    const resourceId = resource.id as string;
    const client = getClient();
    await new DeleteQuery(tableName).where('resourceId', Operator.EQUALS, resourceId).execute(client);
  }
}
