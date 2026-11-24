// SPDX-License-Identifier: AGPL-3.0
// Macssen zone scope: restricts a role to the records of its assigned zones.
// Design and env reference: ./README.md
import { msg } from '@lingui/core/macro';
import { type ObjectRecord } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import {
  TwentyOrmException,
  TwentyOrmExceptionCode,
} from 'src/engine/twenty-orm/exceptions/twenty-orm.exception';
import { type QueryExecutor } from 'src/engine/twenty-orm/executor/types/query-executor.type';
import { compileNamedParameters } from 'src/engine/twenty-orm/sql/utils/compile-named-parameters.util';
import { resolveRoleIdsFromAuthContext } from 'src/engine/twenty-orm/utils/resolve-role-ids-from-auth-context.util';
import {
  type ZoneScopeContext,
  buildIsScopedRoleSql,
  buildMemberZonesSubquerySql,
} from 'src/engine/twenty-orm/zone-scope/apply-zone-scope.util';
import { getZoneScopeConfig } from 'src/engine/twenty-orm/zone-scope/zone-scope-config.util';

const throwZoneScopeViolation = (message: string): never => {
  throw new TwentyOrmException(
    message,
    TwentyOrmExceptionCode.RLS_VALIDATION_FAILED,
    {
      userFriendlyMessage: msg`You can only save records in one of your assigned zones.`,
    },
  );
};

// Returns the zones of the current member when it holds the scoped role, or
// null when writes are not restricted for this caller.
const loadScopedMemberZones = async ({
  context,
  executor,
}: {
  context: ZoneScopeContext;
  executor: QueryExecutor;
}): Promise<string[] | null> => {
  const config = getZoneScopeConfig();

  if (!isDefined(config) || context.shouldBypassPermissionChecks) {
    return null;
  }

  const roleIds = resolveRoleIdsFromAuthContext({
    authContext: context.authContext,
    userWorkspaceRoleMap: context.internalContext.userWorkspaceRoleMap,
    apiKeyRoleMap: context.internalContext.apiKeyRoleMap,
  });

  if (roleIds.length === 0) {
    return null;
  }

  const memberZonesSql = buildMemberZonesSubquerySql({
    context,
    config,
    memberIdParameter: 'zoneScopeWrite_memberId',
  });

  const zonesSql = isDefined(memberZonesSql)
    ? `ARRAY(${memberZonesSql})`
    : 'ARRAY[]::text[]';

  const rows = await executor.execute(
    compileNamedParameters(
      `SELECT ${buildIsScopedRoleSql('zoneScopeWrite_roleIds', 'zoneScopeWrite_roleLabel')} AS "isScoped", ${zonesSql} AS "zones"`,
      {
        zoneScopeWrite_roleIds: roleIds,
        zoneScopeWrite_roleLabel: config.roleLabel,
        ...(isDefined(memberZonesSql) && isUserAuthContext(context.authContext)
          ? { zoneScopeWrite_memberId: context.authContext.workspaceMemberId }
          : {}),
      },
    ),
  );

  if (rows[0]?.isScoped !== true) {
    return null;
  }

  return ((rows[0]?.zones as string[] | null) ?? []).filter(isDefined);
};

const isObjectInScope = (flatObjectMetadata: FlatObjectMetadata) =>
  getZoneScopeConfig()?.objectNamesSingular.includes(
    flatObjectMetadata.nameSingular,
  ) === true;

// Inserts: a missing zone is filled in when the member has exactly one zone,
// because the UI creates an empty record first and edits it afterwards.
export const enforceZoneScopeOnInsert = async ({
  context,
  executor,
  flatObjectMetadata,
  records,
}: {
  context: ZoneScopeContext;
  executor: QueryExecutor;
  flatObjectMetadata: FlatObjectMetadata;
  records: Partial<ObjectRecord>[];
}): Promise<Partial<ObjectRecord>[]> => {
  if (!isObjectInScope(flatObjectMetadata)) {
    return records;
  }

  const zones = await loadScopedMemberZones({ context, executor });

  if (!isDefined(zones)) {
    return records;
  }

  const zoneFieldName = getZoneScopeConfig()?.zoneFieldName ?? 'zona';

  return records.map((record) => {
    const zone = record[zoneFieldName];

    if (!isDefined(zone)) {
      if (zones.length === 1) {
        return { ...record, [zoneFieldName]: zones[0] };
      }

      return throwZoneScopeViolation(
        `Created ${flatObjectMetadata.nameSingular} must have a zone`,
      );
    }

    if (!zones.includes(String(zone))) {
      return throwZoneScopeViolation(
        `Created ${flatObjectMetadata.nameSingular} is outside the zones of the current member`,
      );
    }

    return record;
  });
};

// Updates: the rows themselves are already filtered by the read predicate, so
// only a change of zone needs checking.
export const enforceZoneScopeOnUpdate = async ({
  context,
  executor,
  flatObjectMetadata,
  updates,
}: {
  context: ZoneScopeContext;
  executor: QueryExecutor;
  flatObjectMetadata: FlatObjectMetadata;
  updates: (Partial<ObjectRecord> | undefined)[];
}): Promise<void> => {
  const zoneFieldName = getZoneScopeConfig()?.zoneFieldName ?? 'zona';

  if (
    !isObjectInScope(flatObjectMetadata) ||
    !updates.some((update) => isDefined(update) && zoneFieldName in update)
  ) {
    return;
  }

  const zones = await loadScopedMemberZones({ context, executor });

  if (!isDefined(zones)) {
    return;
  }

  for (const update of updates) {
    if (!isDefined(update) || !(zoneFieldName in update)) {
      continue;
    }

    const zone = update[zoneFieldName];

    if (!isDefined(zone) || !zones.includes(String(zone))) {
      throwZoneScopeViolation(
        `Updated ${flatObjectMetadata.nameSingular} is outside the zones of the current member`,
      );
    }
  }
};
