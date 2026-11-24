// SPDX-License-Identifier: AGPL-3.0
import { randomUUID } from 'crypto';

import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { destroyManyOperationFactory } from 'test/integration/graphql/utils/destroy-many-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { createOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/create-one-object-metadata.util';
import { deleteOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/delete-one-object-metadata.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { updateOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/update-one-object-metadata.util';
import { createOneRole } from 'test/integration/metadata/suites/role/utils/create-one-role.util';
import { deleteOneRole } from 'test/integration/metadata/suites/role/utils/delete-one-role.util';
import { findOneRoleByLabel } from 'test/integration/metadata/suites/role/utils/find-one-role-by-label.util';
import { updateWorkspaceMemberRole } from 'test/integration/metadata/suites/role/utils/update-workspace-member-role.util';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

// Must match ZONE_SCOPE_ROLE in the environment the test server boots with.
export const ZONE_SCOPE_TEST_ROLE_LABEL = 'Zone Scope Seller';

export const ZONE_NORTH = 'NORTE';
export const ZONE_SOUTH = 'SUR';

const ZONE_OPTIONS = [
  { label: 'Norte', value: ZONE_NORTH, color: 'blue', position: 0 },
  { label: 'Sur', value: ZONE_SOUTH, color: 'red', position: 1 },
];

const SCOPED_OBJECTS = [
  { nameSingular: 'company', namePlural: 'companies' },
  { nameSingular: 'person', namePlural: 'people' },
  { nameSingular: 'opportunity', namePlural: 'opportunities' },
] as const;

export type ZoneScopeRecords = {
  marker: string;
  companyNorthId: string;
  companySouthId: string;
  companyWithoutZoneId: string;
  personNorthId: string;
  personSouthId: string;
  personNorthWithSouthCompanyId: string;
  opportunityNorthId: string;
  opportunitySouthId: string;
  opportunityNorthWithSouthCompanyId: string;
  assignmentId: string;
};

export type ZoneScopeSetup = {
  roleId: string;
  originalMemberRoleId: string;
  zoneFieldIds: string[];
  assignmentObjectId: string;
  records: ZoneScopeRecords;
};

const createMany = async (
  nameSingular: string,
  namePlural: string,
  data: Record<string, unknown>[],
) => {
  const response = await makeGraphqlAPIRequest(
    createManyOperationFactory({
      objectMetadataSingularName: nameSingular,
      objectMetadataPluralName: namePlural,
      gqlFields: 'id',
      data,
    }),
  );

  if (isDefined(response.body.errors)) {
    throw new Error(
      `zone-scope setup: create ${namePlural} failed: ${JSON.stringify(response.body.errors)}`,
    );
  }
};

export const setupZoneScope = async (): Promise<ZoneScopeSetup> => {
  const { objects } = await findManyObjectMetadata({
    expectToFail: false,
    input: { filter: {}, paging: { first: 1000 } },
    gqlFields: 'id nameSingular',
  });

  const objectIdByName = Object.fromEntries(
    objects.map((object) => [object.nameSingular, object.id]),
  );

  const zoneFieldIds: string[] = [];

  for (const { nameSingular } of SCOPED_OBJECTS) {
    const { data } = await createOneFieldMetadata({
      expectToFail: false,
      input: {
        objectMetadataId: objectIdByName[nameSingular],
        name: 'zona',
        label: 'Zona',
        type: FieldMetadataType.SELECT,
        options: ZONE_OPTIONS,
        isLabelSyncedWithName: false,
      },
      gqlFields: 'id',
    });

    zoneFieldIds.push(data.createOneField.id);
  }

  const { data: objectData } = await createOneObjectMetadata({
    expectToFail: false,
    input: {
      nameSingular: 'asignacionZona',
      namePlural: 'asignacionesZona',
      labelSingular: 'Asignación de zona',
      labelPlural: 'Asignaciones de zona',
      icon: 'IconMap',
      isLabelSyncedWithName: false,
    },
    gqlFields: 'id',
  });

  const assignmentObjectId = objectData.createOneObject.id;

  await createOneFieldMetadata({
    expectToFail: false,
    input: {
      objectMetadataId: assignmentObjectId,
      name: 'zonas',
      label: 'Zonas',
      type: FieldMetadataType.MULTI_SELECT,
      options: ZONE_OPTIONS,
      isLabelSyncedWithName: false,
    },
    gqlFields: 'id',
  });

  await createOneFieldMetadata({
    expectToFail: false,
    input: {
      objectMetadataId: assignmentObjectId,
      name: 'vendedor',
      label: 'Vendedor',
      type: FieldMetadataType.RELATION,
      isLabelSyncedWithName: false,
      relationCreationPayload: {
        targetObjectMetadataId: objectIdByName.workspaceMember,
        targetFieldLabel: 'Asignaciones de zona',
        targetFieldIcon: 'IconMap',
        type: RelationType.MANY_TO_ONE,
      },
    },
    gqlFields: 'id',
  });

  const memberRole = await findOneRoleByLabel({ label: 'Member' });

  const { data: roleData } = await createOneRole({
    expectToFail: false,
    input: {
      label: ZONE_SCOPE_TEST_ROLE_LABEL,
      description: 'Seller restricted to assigned zones',
      icon: 'IconMap',
      canUpdateAllSettings: false,
      canAccessAllTools: true,
      canReadAllObjectRecords: true,
      canUpdateAllObjectRecords: true,
      canSoftDeleteAllObjectRecords: true,
      canDestroyAllObjectRecords: true,
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: true,
    },
  });

  const roleId = roleData.createOneRole.id;

  await updateWorkspaceMemberRole({
    input: { roleId, workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY },
    expectToFail: false,
  });

  const marker = `ZoneScope${randomUUID().slice(0, 8)}`;
  const records: ZoneScopeRecords = {
    marker,
    companyNorthId: randomUUID(),
    companySouthId: randomUUID(),
    companyWithoutZoneId: randomUUID(),
    personNorthId: randomUUID(),
    personSouthId: randomUUID(),
    personNorthWithSouthCompanyId: randomUUID(),
    opportunityNorthId: randomUUID(),
    opportunitySouthId: randomUUID(),
    opportunityNorthWithSouthCompanyId: randomUUID(),
    assignmentId: randomUUID(),
  };

  await createMany('company', 'companies', [
    { id: records.companyNorthId, name: `${marker} North`, zona: ZONE_NORTH },
    { id: records.companySouthId, name: `${marker} South`, zona: ZONE_SOUTH },
    { id: records.companyWithoutZoneId, name: `${marker} Nowhere` },
  ]);

  await createMany('person', 'people', [
    {
      id: records.personNorthId,
      name: { firstName: marker, lastName: 'North' },
      zona: ZONE_NORTH,
      companyId: records.companyNorthId,
    },
    {
      id: records.personSouthId,
      name: { firstName: marker, lastName: 'South' },
      zona: ZONE_SOUTH,
      companyId: records.companySouthId,
    },
    {
      id: records.personNorthWithSouthCompanyId,
      name: { firstName: marker, lastName: 'NorthOfSouth' },
      zona: ZONE_NORTH,
      companyId: records.companySouthId,
    },
  ]);

  await createMany('opportunity', 'opportunities', [
    {
      id: records.opportunityNorthId,
      name: `${marker} North deal`,
      zona: ZONE_NORTH,
      companyId: records.companyNorthId,
      amount: { amountMicros: 1_000_000_000, currencyCode: 'USD' },
    },
    {
      id: records.opportunitySouthId,
      name: `${marker} South deal`,
      zona: ZONE_SOUTH,
      companyId: records.companySouthId,
      amount: { amountMicros: 7_000_000_000, currencyCode: 'USD' },
    },
    {
      id: records.opportunityNorthWithSouthCompanyId,
      name: `${marker} North deal of South`,
      zona: ZONE_NORTH,
      companyId: records.companySouthId,
    },
  ]);

  await createMany('asignacionZona', 'asignacionesZona', [
    {
      id: records.assignmentId,
      name: `${marker} Jony`,
      zonas: [ZONE_NORTH],
      vendedorId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    },
  ]);

  return {
    roleId,
    originalMemberRoleId: memberRole.id,
    zoneFieldIds,
    assignmentObjectId,
    records,
  };
};

const destroyByIds = async (
  nameSingular: string,
  namePlural: string,
  ids: string[],
) => {
  await makeGraphqlAPIRequest(
    destroyManyOperationFactory({
      objectMetadataSingularName: nameSingular,
      objectMetadataPluralName: namePlural,
      gqlFields: 'id',
      filter: { id: { in: ids } },
    }),
  );
};

export const cleanupZoneScope = async (
  setup: Partial<ZoneScopeSetup> = {},
  extraIdsByObject: Record<string, string[]> = {},
): Promise<void> => {
  const { records } = setup;

  if (isDefined(records)) {
    await destroyByIds('opportunity', 'opportunities', [
      records.opportunityNorthId,
      records.opportunitySouthId,
      records.opportunityNorthWithSouthCompanyId,
      ...(extraIdsByObject.opportunity ?? []),
    ]);
    await destroyByIds('person', 'people', [
      records.personNorthId,
      records.personSouthId,
      records.personNorthWithSouthCompanyId,
      ...(extraIdsByObject.person ?? []),
    ]);
    await destroyByIds('company', 'companies', [
      records.companyNorthId,
      records.companySouthId,
      records.companyWithoutZoneId,
      ...(extraIdsByObject.company ?? []),
    ]);
  }

  if (isDefined(setup.originalMemberRoleId)) {
    await updateWorkspaceMemberRole({
      input: {
        roleId: setup.originalMemberRoleId,
        workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
      },
      expectToFail: false,
    });
  }

  if (isDefined(setup.roleId)) {
    await deleteOneRole({ input: { idToDelete: setup.roleId } });
  }

  if (isDefined(setup.assignmentObjectId)) {
    await updateOneObjectMetadata({
      input: {
        idToUpdate: setup.assignmentObjectId,
        updatePayload: { isActive: false },
      },
    });
    await deleteOneObjectMetadata({
      input: { idToDelete: setup.assignmentObjectId },
    });
  }

  for (const fieldId of setup.zoneFieldIds ?? []) {
    await updateOneFieldMetadata({
      input: { idToUpdate: fieldId, updatePayload: { isActive: false } },
    });
    await deleteOneFieldMetadata({ input: { idToDelete: fieldId } });
  }
};
