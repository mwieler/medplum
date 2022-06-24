import { createReference, getReferenceString, MedplumClient, ProfileResource } from '@medplum/core';
import { Attachment, Patient, Reference } from '@medplum/fhirtypes';
import React from 'react';
import { ResourceTimeline } from './ResourceTimeline';

export interface PatientTimelineProps {
  patient: Patient | Reference<Patient>;
}

export function PatientTimeline(props: PatientTimelineProps): JSX.Element {
  return (
    <ResourceTimeline
      value={props.patient}
      loadTimelineResources={async (medplum: MedplumClient, resource: Patient) => {
        return Promise.all([
          medplum.readHistory('Patient', resource.id as string),
          medplum.search('Communication', 'subject=' + getReferenceString(resource)),
          medplum.search('Device', 'patient=' + getReferenceString(resource)),
          medplum.search('DeviceRequest', 'patient=' + getReferenceString(resource)),
          medplum.search('DiagnosticReport', 'subject=' + getReferenceString(resource)),
          medplum.search('Media', 'subject=' + getReferenceString(resource)),
          medplum.search('ServiceRequest', 'subject=' + getReferenceString(resource)),
        ]);
      }}
      createCommunication={(resource: Patient, sender: ProfileResource, text: string) => ({
        resourceType: 'Communication',
        subject: createReference(resource),
        sender: createReference(sender),
        sent: new Date().toISOString(),
        payload: [{ contentString: text }],
      })}
      createMedia={(resource: Patient, operator: ProfileResource, content: Attachment) => ({
        resourceType: 'Media',
        subject: createReference(resource),
        operator: createReference(operator),
        issued: new Date().toISOString(),
        content,
      })}
    />
  );
}
