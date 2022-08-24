/*
 * Generated by @medplum/generator
 * Do not edit manually.
 */

import { PoolClient } from 'pg';

export async function run(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS "Token" (
    "id" UUID NOT NULL PRIMARY KEY,
    "resourceId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "system" TEXT,
    "value" TEXT
  )`);

  await client.query('CREATE INDEX ON "Token" ("resourceId")');
  await client.query('CREATE INDEX ON "Token" ("code")');
  await client.query('CREATE INDEX ON "Token" ("system")');
  await client.query('CREATE INDEX ON "Token" ("value")');
}
