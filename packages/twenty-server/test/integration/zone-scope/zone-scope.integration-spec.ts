// SPDX-License-Identifier: AGPL-3.0
// Leak matrix for the Macssen zone scope (see src/engine/twenty-orm/zone-scope/README.md).
// Requires the test server to boot with ZONE_SCOPE_ROLE="Zone Scope Seller".
import gql from 'graphql-tag';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { deleteOneOperationFactory } from 'test/integration/graphql/utils/delete-one-operation-factory.util';
import { destroyOneOperationFactory } from 'test/integration/graphql/utils/destroy-one-operation-factory.util';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { generateApiKeyToken } from 'test/integration/graphql/utils/generate-api-key-token.util';
import { findOneOperationFactory } from 'test/integration/graphql/utils/find-one-operation-factory.util';
import { groupByOperationFactory } from 'test/integration/graphql/utils/group-by-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { updateManyOperationFactory } from 'test/integration/graphql/utils/update-many-operation-factory.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';
import {
  ZONE_NORTH,
  ZONE_SOUTH,
  type ZoneScopeSetup,
  cleanupZoneScope,
  setupZoneScope,
} from 'test/integration/zone-scope/utils/setup-zone-scope.util';
import { randomUUID } from 'crypto';
import { isDefined } from 'twenty-shared/utils';

const SELLER_TOKEN = () => APPLE_JONY_MEMBER_ACCESS_TOKEN;
const ADMIN_TOKEN = () => APPLE_JANE_ADMIN_ACCESS_TOKEN;

type Edge = { node: { id: string } };

const edgeIds = (edges: Edge[] | undefined): string[] =>
  (edges ?? []).map((edge) => edge.node.id).sort();

const sorted = (ids: string[]) => [...ids].sort();

describe('zone scope (Macssen fork)', () => {
  let setup: ZoneScopeSetup;
  const createdCompanyIds: string[] = [];

  const findIds = async ({
    nameSingular,
    namePlural,
    ids,
    token,
  }: {
    nameSingular: string;
    namePlural: string;
    ids: string[];
    token: string;
  }) => {
    const response = await makeGraphqlAPIRequest(
      findManyOperationFactory({
        objectMetadataSingularName: nameSingular,
        objectMetadataPluralName: namePlural,
        gqlFields: 'id',
        filter: { id: { in: ids } },
      }),
      token,
    );

    expect(response.body.errors).toBeUndefined();

    return edgeIds(response.body.data[namePlural].edges);
  };

  const allCompanyIds = () => [
    setup.records.companyNorthId,
    setup.records.companySouthId,
    setup.records.companyWithoutZoneId,
  ];

  const findCompanyAsAdmin = async (id: string, gqlFields: string) => {
    const response = await makeGraphqlAPIRequest(
      findOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields,
        filter: { id: { eq: id } },
      }),
      ADMIN_TOKEN(),
    );

    return response.body.data?.company;
  };

  beforeAll(async () => {
    setup = await setupZoneScope();
  });

  afterAll(async () => {
    await cleanupZoneScope(setup, { company: createdCompanyIds });
  });

  describe('reads', () => {
    it('lists only companies of the seller zone', async () => {
      expect(
        await findIds({
          nameSingular: 'company',
          namePlural: 'companies',
          ids: allCompanyIds(),
          token: SELLER_TOKEN(),
        }),
      ).toEqual([setup.records.companyNorthId]);
    });

    it('lists only people of the seller zone', async () => {
      expect(
        await findIds({
          nameSingular: 'person',
          namePlural: 'people',
          ids: [
            setup.records.personNorthId,
            setup.records.personSouthId,
            setup.records.personNorthWithSouthCompanyId,
          ],
          token: SELLER_TOKEN(),
        }),
      ).toEqual(
        sorted([
          setup.records.personNorthId,
          setup.records.personNorthWithSouthCompanyId,
        ]),
      );
    });

    it('lists only opportunities of the seller zone', async () => {
      expect(
        await findIds({
          nameSingular: 'opportunity',
          namePlural: 'opportunities',
          ids: [
            setup.records.opportunityNorthId,
            setup.records.opportunitySouthId,
            setup.records.opportunityNorthWithSouthCompanyId,
          ],
          token: SELLER_TOKEN(),
        }),
      ).toEqual(
        sorted([
          setup.records.opportunityNorthId,
          setup.records.opportunityNorthWithSouthCompanyId,
        ]),
      );
    });

    it('lets the admin see every zone', async () => {
      expect(
        await findIds({
          nameSingular: 'company',
          namePlural: 'companies',
          ids: allCompanyIds(),
          token: ADMIN_TOKEN(),
        }),
      ).toEqual(sorted(allCompanyIds()));
    });

    it('returns nothing for findOne on a record of another zone', async () => {
      const response = await makeGraphqlAPIRequest(
        findOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id name',
          filter: { id: { eq: setup.records.companySouthId } },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.data?.company ?? null).toBeNull();
    });

    it('counts only records of the seller zone', async () => {
      const response = await makeGraphqlAPIRequest(
        {
          query: gql`
            query ZoneScopeCount($filter: CompanyFilterInput) {
              companies(filter: $filter) {
                totalCount
              }
            }
          `,
          variables: { filter: { id: { in: allCompanyIds() } } },
        },
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.companies.totalCount).toBe(1);
    });

    it('aggregates only records of the seller zone', async () => {
      const response = await makeGraphqlAPIRequest(
        {
          query: gql`
            query ZoneScopeSum($filter: OpportunityFilterInput) {
              opportunities(filter: $filter) {
                totalCount
                sumAmountAmountMicros
              }
            }
          `,
          variables: {
            filter: { name: { like: `${setup.records.marker}%` } },
          },
        },
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.opportunities.totalCount).toBe(2);
      expect(response.body.data.opportunities.sumAmountAmountMicros).toBe(
        1_000_000_000,
      );
    });

    it('groups only records of the seller zone', async () => {
      const response = await makeGraphqlAPIRequest(
        groupByOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          groupBy: [{ zona: true }],
          filter: { id: { in: allCompanyIds() } },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();

      const groups = response.body.data.companiesGroupBy as {
        groupByDimensionValues: string[];
        totalCount: number;
      }[];

      expect(groups).toEqual([
        expect.objectContaining({
          groupByDimensionValues: [ZONE_NORTH],
          totalCount: 1,
        }),
      ]);
    });

    it('searches only records of the seller zone', async () => {
      const { data } = await search({
        searchInput: setup.records.marker,
        limit: 50,
        includedObjectNameSingulars: ['company', 'person', 'opportunity'],
        accessToken: SELLER_TOKEN(),
      });

      const foundIds = sorted(
        data.search.edges.map(
          (edge: { node: { recordId: string } }) => edge.node.recordId,
        ),
      );

      expect(foundIds).toEqual(
        sorted([
          setup.records.companyNorthId,
          setup.records.personNorthId,
          setup.records.personNorthWithSouthCompanyId,
          setup.records.opportunityNorthId,
          setup.records.opportunityNorthWithSouthCompanyId,
        ]),
      );
    });

    it('hides a related company of another zone in nested reads', async () => {
      const response = await makeGraphqlAPIRequest(
        findOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id name }',
          filter: { id: { eq: setup.records.personNorthWithSouthCompanyId } },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.person.company ?? null).toBeNull();
    });

    it('lists only same-zone records in a to-many relation', async () => {
      const response = await makeGraphqlAPIRequest(
        findOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields:
            'id people { edges { node { id } } } opportunities { edges { node { id } } }',
          filter: { id: { eq: setup.records.companyNorthId } },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      expect(edgeIds(response.body.data.company.people.edges)).toEqual([
        setup.records.personNorthId,
      ]);
      expect(edgeIds(response.body.data.company.opportunities.edges)).toEqual([
        setup.records.opportunityNorthId,
      ]);
    });

    it('does not match a relation filter on a company of another zone', async () => {
      const response = await makeGraphqlAPIRequest(
        findManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id',
          filter: {
            company: { name: { like: `${setup.records.marker} South` } },
          },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.people.edges).toHaveLength(0);
    });

    it('lists only same-zone records through REST', async () => {
      const response = await makeRestAPIRequest({
        method: 'get',
        path: `/companies?filter=id[in]:[${allCompanyIds().join(',')}]`,
        bearer: SELLER_TOKEN(),
      });

      expect(response.status).toBe(200);

      const ids = (response.body.data.companies as { id: string }[]).map(
        (company) => company.id,
      );

      expect(ids).toEqual([setup.records.companyNorthId]);
    });

    it('does not return a record of another zone by id through REST', async () => {
      const response = await makeRestAPIRequest({
        method: 'get',
        path: `/companies/${setup.records.companySouthId}`,
        bearer: SELLER_TOKEN(),
      });

      expect(response.body.data?.company ?? null).toBeNull();
    });
  });

  describe('linked activity', () => {
    beforeAll(async () => {
      await waitForAllJobsToFinish();
    });

    it('hides timeline activities of a company of another zone', async () => {
      const response = await makeGraphqlAPIRequest(
        findManyOperationFactory({
          objectMetadataSingularName: 'timelineActivity',
          objectMetadataPluralName: 'timelineActivities',
          gqlFields: 'id',
          filter: { targetCompanyId: { eq: setup.records.companySouthId } },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.timelineActivities.edges).toHaveLength(0);
    });

    it('shows timeline activities of a company of the seller zone', async () => {
      const response = await makeGraphqlAPIRequest(
        findManyOperationFactory({
          objectMetadataSingularName: 'timelineActivity',
          objectMetadataPluralName: 'timelineActivities',
          gqlFields: 'id',
          filter: { targetCompanyId: { eq: setup.records.companyNorthId } },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      expect(
        response.body.data.timelineActivities.edges.length,
      ).toBeGreaterThan(0);
    });
  });

  describe('notes and tasks', () => {
    const noteSouthId = randomUUID();
    const noteNorthId = randomUUID();
    const noteUnlinkedId = randomUUID();
    const taskSouthId = randomUUID();
    const noteTargetSouthId = randomUUID();

    const adminCreate = async (
      nameSingular: string,
      data: Record<string, unknown>,
    ) => {
      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: nameSingular,
          gqlFields: 'id',
          data,
        }),
        ADMIN_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
    };

    beforeAll(async () => {
      await adminCreate('note', { id: noteSouthId, title: 'South note' });
      await adminCreate('note', { id: noteNorthId, title: 'North note' });
      await adminCreate('note', { id: noteUnlinkedId, title: 'Free note' });
      await adminCreate('task', { id: taskSouthId, title: 'South task' });
      await adminCreate('noteTarget', {
        id: noteTargetSouthId,
        noteId: noteSouthId,
        targetCompanyId: setup.records.companySouthId,
      });
      await adminCreate('noteTarget', {
        noteId: noteNorthId,
        targetCompanyId: setup.records.companyNorthId,
      });
      await adminCreate('taskTarget', {
        taskId: taskSouthId,
        targetPersonId: setup.records.personSouthId,
      });
    });

    afterAll(async () => {
      for (const [nameSingular, id] of [
        ['note', noteSouthId],
        ['note', noteNorthId],
        ['note', noteUnlinkedId],
        ['task', taskSouthId],
      ]) {
        await makeGraphqlAPIRequest(
          destroyOneOperationFactory({
            objectMetadataSingularName: nameSingular,
            gqlFields: 'id',
            recordId: id,
          }),
          ADMIN_TOKEN(),
        );
      }
    });

    it('hides notes linked to another zone and keeps the rest', async () => {
      expect(
        await findIds({
          nameSingular: 'note',
          namePlural: 'notes',
          ids: [noteSouthId, noteNorthId, noteUnlinkedId],
          token: SELLER_TOKEN(),
        }),
      ).toEqual(sorted([noteNorthId, noteUnlinkedId]));
    });

    it('hides tasks linked to another zone', async () => {
      expect(
        await findIds({
          nameSingular: 'task',
          namePlural: 'tasks',
          ids: [taskSouthId],
          token: SELLER_TOKEN(),
        }),
      ).toEqual([]);
    });

    it('hides note targets pointing to another zone', async () => {
      expect(
        await findIds({
          nameSingular: 'noteTarget',
          namePlural: 'noteTargets',
          ids: [noteTargetSouthId],
          token: SELLER_TOKEN(),
        }),
      ).toEqual([]);
    });

    it('lets the admin see every note', async () => {
      expect(
        await findIds({
          nameSingular: 'note',
          namePlural: 'notes',
          ids: [noteSouthId, noteNorthId, noteUnlinkedId],
          token: ADMIN_TOKEN(),
        }),
      ).toEqual(sorted([noteSouthId, noteNorthId, noteUnlinkedId]));
    });
  });

  describe('api key with the seller role', () => {
    let apiKeyId: string | undefined;
    let apiKeyToken: string;

    beforeAll(async () => {
      const response = await makeMetadataAPIRequest({
        query: gql`
          mutation CreateApiKey($input: CreateApiKeyInput!) {
            createApiKey(input: $input) {
              id
            }
          }
        `,
        variables: {
          input: {
            name: 'Zone scope seller key',
            expiresAt: '2099-01-01T00:00:00Z',
            roleId: setup.roleId,
          },
        },
      });

      expect(response.body.errors).toBeUndefined();
      apiKeyId = response.body.data.createApiKey.id;

      const tokenResponse = await generateApiKeyToken({
        apiKeyId: apiKeyId as string,
        accessToken: ADMIN_TOKEN(),
      });

      apiKeyToken = tokenResponse.body.data.generateApiKeyToken.token;
    });

    afterAll(async () => {
      if (isDefined(apiKeyId)) {
        await globalThis.testDataSource.query(
          'DELETE FROM core."apiKey" WHERE id = $1',
          [apiKeyId],
        );
      }
    });

    it('sees no scoped record, since an api key has no zones', async () => {
      expect(
        await findIds({
          nameSingular: 'company',
          namePlural: 'companies',
          ids: allCompanyIds(),
          token: apiKeyToken,
        }),
      ).toEqual([]);
    });
  });

  describe('writes', () => {
    it('does not update a record of another zone', async () => {
      await makeGraphqlAPIRequest(
        updateOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: setup.records.companySouthId,
          data: { name: 'hijacked' },
        }),
        SELLER_TOKEN(),
      );

      const company = await findCompanyAsAdmin(
        setup.records.companySouthId,
        'name',
      );

      expect(company.name).toBe(`${setup.records.marker} South`);
    });

    it('updates only same-zone records in a bulk update', async () => {
      await makeGraphqlAPIRequest(
        updateManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: 'id',
          filter: { id: { in: allCompanyIds() } },
          data: { employees: 42 },
        }),
        SELLER_TOKEN(),
      );

      const north = await findCompanyAsAdmin(
        setup.records.companyNorthId,
        'employees',
      );
      const south = await findCompanyAsAdmin(
        setup.records.companySouthId,
        'employees',
      );

      expect(north.employees).toBe(42);
      expect(south.employees).not.toBe(42);
    });

    it('does not soft-delete a record of another zone', async () => {
      await makeGraphqlAPIRequest(
        deleteOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: setup.records.companySouthId,
        }),
        SELLER_TOKEN(),
      );

      const company = await findCompanyAsAdmin(
        setup.records.companySouthId,
        'id deletedAt',
      );

      expect(company?.id).toBe(setup.records.companySouthId);
      expect(company?.deletedAt ?? null).toBeNull();
    });

    it('does not destroy a record of another zone', async () => {
      await makeGraphqlAPIRequest(
        destroyOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: setup.records.companySouthId,
        }),
        SELLER_TOKEN(),
      );

      const company = await findCompanyAsAdmin(
        setup.records.companySouthId,
        'id',
      );

      expect(company?.id).toBe(setup.records.companySouthId);
    });

    it('rejects moving a record to another zone', async () => {
      const response = await makeGraphqlAPIRequest(
        updateOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: setup.records.companyNorthId,
          data: { zona: ZONE_SOUTH },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeDefined();

      const company = await findCompanyAsAdmin(
        setup.records.companyNorthId,
        'zona',
      );

      expect(company.zona).toBe(ZONE_NORTH);
    });

    it('rejects clearing the zone of a record', async () => {
      const response = await makeGraphqlAPIRequest(
        updateOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: setup.records.companyNorthId,
          data: { zona: null },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeDefined();
    });

    it('rejects creating a record in another zone', async () => {
      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          data: { name: `${setup.records.marker} Intruder`, zona: ZONE_SOUTH },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeDefined();

      const createdId = response.body.data?.createCompany?.id;

      if (isDefined(createdId)) {
        createdCompanyIds.push(createdId);
      }

      expect(createdId ?? null).toBeNull();
    });

    it('fills in the only zone of the seller when creating without one', async () => {
      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id zona',
          data: { name: `${setup.records.marker} Created` },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      createdCompanyIds.push(response.body.data.createCompany.id);
      expect(response.body.data.createCompany.zona).toBe(ZONE_NORTH);
    });

    it('creates a record in the seller zone', async () => {
      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id zona',
          data: { name: `${setup.records.marker} Created2`, zona: ZONE_NORTH },
        }),
        SELLER_TOKEN(),
      );

      expect(response.body.errors).toBeUndefined();
      createdCompanyIds.push(response.body.data.createCompany.id);
    });
  });

  describe('fail closed', () => {
    it('shows nothing once the seller has no zone assignment', async () => {
      const softDelete = await makeGraphqlAPIRequest(
        deleteOneOperationFactory({
          objectMetadataSingularName: 'asignacionZona',
          gqlFields: 'id',
          recordId: setup.records.assignmentId,
        }),
        ADMIN_TOKEN(),
      );

      expect(softDelete.body.errors).toBeUndefined();

      try {
        expect(
          await findIds({
            nameSingular: 'company',
            namePlural: 'companies',
            ids: allCompanyIds(),
            token: SELLER_TOKEN(),
          }),
        ).toEqual([]);
      } finally {
        await makeGraphqlAPIRequest(
          {
            query: gql`
              mutation RestoreAssignment($id: UUID!) {
                restoreAsignacionZona(id: $id) {
                  id
                }
              }
            `,
            variables: { id: setup.records.assignmentId },
          },
          ADMIN_TOKEN(),
        );
      }

      expect(
        await findIds({
          nameSingular: 'company',
          namePlural: 'companies',
          ids: allCompanyIds(),
          token: SELLER_TOKEN(),
        }),
      ).toEqual([setup.records.companyNorthId]);
    });
  });
});
