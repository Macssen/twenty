// SPDX-License-Identifier: AGPL-3.0
// Macssen zone scope: restricts a role to the records of its assigned zones.
// Design and env reference: ./README.md
import { isDefined } from 'twenty-shared/utils';

import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { resolveRoleIdsFromAuthContext } from 'src/engine/twenty-orm/utils/resolve-role-ids-from-auth-context.util';
import {
  type ZoneScopeConfig,
  getZoneScopeConfig,
} from 'src/engine/twenty-orm/zone-scope/zone-scope-config.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

export type ZoneScopeContext = {
  authContext: WorkspaceAuthContext;
  internalContext: WorkspaceInternalContext;
  tableShapeByObjectMetadataId: (
    objectMetadataId: string,
  ) => WorkspaceTableShape;
  shouldBypassPermissionChecks: boolean;
};

export type ZoneScopeSqlFragment = {
  sql: string;
  parameters: Record<string, unknown>;
};

const SQL_FALSE = 'FALSE';

const toParameterPrefix = (alias: string): string =>
  `zoneScope_${alias.replace(/[^A-Za-z0-9_]/g, '_')}`;

const findTableShapeByNameSingular = (
  context: ZoneScopeContext,
  nameSingular: string,
): WorkspaceTableShape | undefined => {
  const objectMetadataId =
    context.internalContext.objectIdByNameSingular[nameSingular];

  if (!isDefined(objectMetadataId)) {
    return undefined;
  }

  try {
    return context.tableShapeByObjectMetadataId(objectMetadataId);
  } catch {
    return undefined;
  }
};

const hasColumn = (tableShape: WorkspaceTableShape, columnName: string) =>
  isDefined(tableShape.columnShapeByColumnName[columnName]);

const resolveRoleIds = (context: ZoneScopeContext): string[] =>
  resolveRoleIdsFromAuthContext({
    authContext: context.authContext,
    userWorkspaceRoleMap: context.internalContext.userWorkspaceRoleMap,
    apiKeyRoleMap: context.internalContext.apiKeyRoleMap,
  });

// The role label is not in the request context, so the role check is part of
// the SQL. Postgres runs this uncorrelated EXISTS once per statement.
export const buildIsScopedRoleSql = (
  roleIdsParameter: string,
  roleLabelParameter: string,
): string =>
  `EXISTS (SELECT 1 FROM "core"."role" "zoneScopeRole" WHERE "zoneScopeRole"."id" = ANY(:${roleIdsParameter}::uuid[]) AND "zoneScopeRole"."label" = :${roleLabelParameter})`;

// Returns the zone set of the current member as a subquery, or null when the
// caller has no workspace member or the assignment object is misconfigured.
// Callers must treat null as "no zones" (fail closed).
export const buildMemberZonesSubquerySql = ({
  context,
  config,
  memberIdParameter,
}: {
  context: ZoneScopeContext;
  config: ZoneScopeConfig;
  memberIdParameter: string;
}): string | null => {
  if (!isUserAuthContext(context.authContext)) {
    return null;
  }

  const assignmentTableShape = findTableShapeByNameSingular(
    context,
    config.assignmentObjectNameSingular,
  );

  if (!isDefined(assignmentTableShape)) {
    return null;
  }

  const memberRelationShape =
    assignmentTableShape.relationShapeByFieldName[
      config.assignmentMemberFieldName
    ];

  if (
    !isDefined(memberRelationShape?.joinColumnName) ||
    memberRelationShape.relationType !== RelationType.MANY_TO_ONE ||
    !hasColumn(assignmentTableShape, config.assignmentZonesFieldName)
  ) {
    return null;
  }

  const assignmentTable = `${escapeIdentifier(assignmentTableShape.schemaName)}.${escapeIdentifier(assignmentTableShape.tableName)}`;
  const softDeletePredicate = assignmentTableShape.hasDeletedAtColumn
    ? ` AND "zoneScopeAssignment"."deletedAt" IS NULL`
    : '';

  return `SELECT unnest("zoneScopeAssignment".${escapeIdentifier(config.assignmentZonesFieldName)})::text FROM ${assignmentTable} "zoneScopeAssignment" WHERE "zoneScopeAssignment".${escapeIdentifier(memberRelationShape.joinColumnName)} = :${memberIdParameter}${softDeletePredicate}`;
};

type PredicateBuildState = {
  context: ZoneScopeContext;
  config: ZoneScopeConfig;
  memberZonesSql: string | null;
  scopedTableShapeByObjectMetadataId: Map<string, WorkspaceTableShape>;
  nextAliasIndex: number;
};

const buildDirectZoneSql = (
  state: PredicateBuildState,
  alias: string,
  tableShape: WorkspaceTableShape,
): string => {
  if (
    !isDefined(state.memberZonesSql) ||
    !hasColumn(tableShape, state.config.zoneFieldName)
  ) {
    return SQL_FALSE;
  }

  return `${escapeIdentifier(alias)}.${escapeIdentifier(state.config.zoneFieldName)}::text IN (${state.memberZonesSql})`;
};

// A dependent row (timeline entry, note target, attachment...) stays visible
// only while every scoped record it points to is visible.
const buildDependentSql = (
  state: PredicateBuildState,
  alias: string,
  tableShape: WorkspaceTableShape,
): string => {
  const conditions = Object.values(tableShape.relationShapeByFieldName)
    .filter(
      (relationShape) =>
        relationShape.relationType === RelationType.MANY_TO_ONE &&
        isDefined(relationShape.joinColumnName) &&
        state.scopedTableShapeByObjectMetadataId.has(
          relationShape.targetObjectMetadataId,
        ),
    )
    .map((relationShape) => {
      const targetTableShape = state.scopedTableShapeByObjectMetadataId.get(
        relationShape.targetObjectMetadataId,
      ) as WorkspaceTableShape;
      const foreignKeySql = `${escapeIdentifier(alias)}.${escapeIdentifier(relationShape.joinColumnName as string)}`;
      const targetAlias = `zoneScopeTarget${state.nextAliasIndex++}`;
      const targetZoneSql = buildDirectZoneSql(
        state,
        targetAlias,
        targetTableShape,
      );

      return `(${foreignKeySql} IS NULL OR ${foreignKeySql} IN (SELECT "${targetAlias}"."id" FROM ${escapeIdentifier(targetTableShape.schemaName)}.${escapeIdentifier(targetTableShape.tableName)} "${targetAlias}" WHERE ${targetZoneSql}))`;
    });

  return conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';
};

// A linked row (note, task) is hidden as soon as one of its live junction rows
// points to a scoped record outside the member zones.
const buildLinkedSql = (
  state: PredicateBuildState,
  alias: string,
  tableShape: WorkspaceTableShape,
  junctionObjectNameSingular: string,
): string => {
  const junctionTableShape = findTableShapeByNameSingular(
    state.context,
    junctionObjectNameSingular,
  );

  const parentRelationShape = isDefined(junctionTableShape)
    ? Object.values(junctionTableShape.relationShapeByFieldName).find(
        (relationShape) =>
          relationShape.relationType === RelationType.MANY_TO_ONE &&
          relationShape.targetObjectMetadataId ===
            tableShape.objectMetadataId &&
          isDefined(relationShape.joinColumnName),
      )
    : undefined;

  if (!isDefined(junctionTableShape) || !isDefined(parentRelationShape)) {
    return SQL_FALSE;
  }

  const junctionAlias = `zoneScopeJunction${state.nextAliasIndex++}`;
  const softDeletePredicate = junctionTableShape.hasDeletedAtColumn
    ? ` AND "${junctionAlias}"."deletedAt" IS NULL`
    : '';

  return `NOT EXISTS (SELECT 1 FROM ${escapeIdentifier(junctionTableShape.schemaName)}.${escapeIdentifier(junctionTableShape.tableName)} "${junctionAlias}" WHERE "${junctionAlias}".${escapeIdentifier(parentRelationShape.joinColumnName as string)} = ${escapeIdentifier(alias)}."id"${softDeletePredicate} AND NOT (${buildDependentSql(state, junctionAlias, junctionTableShape)}))`;
};

// Builds the read predicate for one aliased table, or null when the object is
// out of scope or the caller is internal. The predicate lets through every
// role except the scoped one; the scoped role sees only rows of its zones,
// and nothing at all when the assignment or the zone field is missing.
export const buildZoneScopePredicate = ({
  context,
  alias,
  flatObjectMetadata,
}: {
  context: ZoneScopeContext;
  alias: string;
  flatObjectMetadata: FlatObjectMetadata;
}): ZoneScopeSqlFragment | null => {
  const config = getZoneScopeConfig();

  if (!isDefined(config) || context.shouldBypassPermissionChecks) {
    return null;
  }

  const nameSingular = flatObjectMetadata.nameSingular;
  const isScopedObject = config.objectNamesSingular.includes(nameSingular);
  const isDependentObject =
    config.dependentObjectNamesSingular.includes(nameSingular);
  const junctionObjectNameSingular =
    config.junctionObjectNameByLinkedObjectNameSingular[nameSingular];

  if (
    !isScopedObject &&
    !isDependentObject &&
    !isDefined(junctionObjectNameSingular)
  ) {
    return null;
  }

  const roleIds = resolveRoleIds(context);

  if (roleIds.length === 0) {
    return null;
  }

  const prefix = toParameterPrefix(alias);
  const parameters: Record<string, unknown> = {
    [`${prefix}_roleIds`]: roleIds,
    [`${prefix}_roleLabel`]: config.roleLabel,
  };

  const memberZonesSql = buildMemberZonesSubquerySql({
    context,
    config,
    memberIdParameter: `${prefix}_memberId`,
  });

  if (isDefined(memberZonesSql) && isUserAuthContext(context.authContext)) {
    parameters[`${prefix}_memberId`] = context.authContext.workspaceMemberId;
  }

  const scopedTableShapeByObjectMetadataId = new Map<
    string,
    WorkspaceTableShape
  >();

  for (const scopedNameSingular of config.objectNamesSingular) {
    const scopedTableShape = findTableShapeByNameSingular(
      context,
      scopedNameSingular,
    );

    if (isDefined(scopedTableShape)) {
      scopedTableShapeByObjectMetadataId.set(
        scopedTableShape.objectMetadataId,
        scopedTableShape,
      );
    }
  }

  const state: PredicateBuildState = {
    context,
    config,
    memberZonesSql,
    scopedTableShapeByObjectMetadataId,
    nextAliasIndex: 0,
  };

  const tableShape = context.tableShapeByObjectMetadataId(
    flatObjectMetadata.id,
  );

  const allowedSql = isScopedObject
    ? buildDirectZoneSql(state, alias, tableShape)
    : isDependentObject
      ? buildDependentSql(state, alias, tableShape)
      : buildLinkedSql(
          state,
          alias,
          tableShape,
          junctionObjectNameSingular as string,
        );

  return {
    sql: `(NOT ${buildIsScopedRoleSql(`${prefix}_roleIds`, `${prefix}_roleLabel`)} OR (${allowedSql}))`,
    parameters,
  };
};

export const applyZoneScope = ({
  context,
  queryBuilder,
  alias,
  flatObjectMetadata,
}: {
  context: ZoneScopeContext;
  queryBuilder: WorkspaceSelectQueryBuilder;
  alias: string;
  flatObjectMetadata: FlatObjectMetadata;
}): void => {
  const predicate = buildZoneScopePredicate({
    context,
    alias,
    flatObjectMetadata,
  });

  if (!isDefined(predicate)) {
    return;
  }

  if (alias === queryBuilder.alias) {
    queryBuilder.andWhere(predicate.sql, predicate.parameters);

    return;
  }

  queryBuilder.addJoinCondition(alias, predicate.sql);
  queryBuilder.setParameters(predicate.parameters);
};
