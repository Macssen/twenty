// SPDX-License-Identifier: AGPL-3.0
// Macssen zone scope: restricts a role to the records of its assigned zones.
// Design and env reference: ./README.md

export type ZoneScopeConfig = {
  roleLabel: string;
  objectNamesSingular: string[];
  zoneFieldName: string;
  assignmentObjectNameSingular: string;
  assignmentMemberFieldName: string;
  assignmentZonesFieldName: string;
  dependentObjectNamesSingular: string[];
  junctionObjectNameByLinkedObjectNameSingular: Record<string, string>;
};

const DEFAULT_OBJECTS = 'company,person,opportunity';
const DEFAULT_DEPENDENT_OBJECTS =
  'timelineActivity,noteTarget,taskTarget,attachment';
const DEFAULT_LINKED_OBJECTS = 'note:noteTarget,task:taskTarget';

const parseList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

let cachedConfig: ZoneScopeConfig | null | undefined;

// Read once per process: a missing ZONE_SCOPE_ROLE disables the feature, so
// the image behaves exactly like upstream for any other tenant.
export const getZoneScopeConfig = (): ZoneScopeConfig | null => {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  const roleLabel = process.env.ZONE_SCOPE_ROLE?.trim();

  cachedConfig =
    roleLabel === undefined || roleLabel.length === 0
      ? null
      : {
          roleLabel,
          objectNamesSingular: parseList(
            process.env.ZONE_SCOPE_OBJECTS ?? DEFAULT_OBJECTS,
          ),
          zoneFieldName: process.env.ZONE_SCOPE_FIELD?.trim() || 'zona',
          assignmentObjectNameSingular:
            process.env.ZONE_SCOPE_ASSIGNMENT_OBJECT?.trim() ||
            'asignacionZona',
          assignmentMemberFieldName:
            process.env.ZONE_SCOPE_ASSIGNMENT_MEMBER_FIELD?.trim() ||
            'vendedor',
          assignmentZonesFieldName:
            process.env.ZONE_SCOPE_ASSIGNMENT_ZONES_FIELD?.trim() || 'zonas',
          dependentObjectNamesSingular: parseList(
            process.env.ZONE_SCOPE_DEPENDENT_OBJECTS ??
              DEFAULT_DEPENDENT_OBJECTS,
          ),
          junctionObjectNameByLinkedObjectNameSingular: Object.fromEntries(
            parseList(
              process.env.ZONE_SCOPE_LINKED_OBJECTS ?? DEFAULT_LINKED_OBJECTS,
            )
              .map((pair) => pair.split(':').map((name) => name.trim()))
              .filter((pair) => pair.length === 2 && pair.every(Boolean)),
          ),
        };

  return cachedConfig;
};

export const resetZoneScopeConfigForTests = (): void => {
  cachedConfig = undefined;
};
