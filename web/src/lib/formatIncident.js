const INCIDENT_TYPE_LABELS = {
  span: 'Span Fault',
  dt: 'DT Outage',
  feeder: 'Feeder Outage',
  sensor_fault: 'Sensor Fault',
};

export function formatIncidentCode(incident) {
  const rawNumber = incident?.incidentNumber ?? incident?.incident_number;
  const numericNumber = Number(rawNumber);

  if (Number.isFinite(numericNumber) && numericNumber > 0) {
    return `INC-${String(numericNumber).padStart(3, '0')}`;
  }

  return incident?.incidentCode ?? incident?.code ?? 'INC-???';
}

export function formatCompactIncidentLabel(incident) {
  return `${formatIncidentCode(incident).replace('INC-', '#')} ${formatIncidentType(
    incident?.type,
  )}`;
}

export function formatIncidentLabel(incident, { includeStatus = false } = {}) {
  const parts = [
    formatIncidentCode(incident),
    formatIncidentType(incident?.type),
    formatIncidentScope(incident),
  ];

  if (includeStatus) {
    parts.push(formatIncidentStatus(incident?.status));
  }

  return parts.filter(Boolean).join(' � ');
}

export function formatIncidentType(type) {
  return INCIDENT_TYPE_LABELS[type] ?? capitalize(type ?? 'Incident');
}

function formatIncidentScope(incident) {
  return incident?.dtId ?? incident?.feederId ?? null;
}

function formatIncidentStatus(status) {
  const labels = {
    detected: 'Detected',
    acknowledged: 'Acknowledged',
    crew_assigned: 'Crew Assigned',
    resolved: 'Resolved',
    verified: 'Verified',
    closed: 'Closed',
  };

  return labels[status] ?? capitalize(status ?? '');
}

function capitalize(value) {
  if (!value) {
    return '';
  }

  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
