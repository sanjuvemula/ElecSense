import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePolling } from './hooks/usePolling.js';

const STATUS_META = {
  detected: {
    label: 'Detected',
    priority: 0,
    tone: 'detected',
    actionLabel: 'Acknowledge',
    actionPath: 'acknowledge',
  },
  acknowledged: {
    label: 'Acknowledged',
    priority: 1,
    tone: 'acknowledged',
    actionLabel: 'Assign Crew',
    actionPath: 'assign-crew',
  },
  crew_assigned: {
    label: 'Crew Assigned',
    priority: 2,
    tone: 'crew-assigned',
    actionLabel: 'Mark Resolved',
    actionPath: 'mark-resolved',
  },
  resolved: {
    label: 'Resolved',
    priority: 3,
    tone: 'resolved',
  },
  verified: {
    label: 'Verified',
    priority: 4,
    tone: 'verified',
    actionLabel: 'Close Incident',
    actionPath: 'close',
  },
  closed: {
    label: 'Closed',
    priority: 5,
    tone: 'closed',
  },
};

const INCIDENT_TYPE_LABELS = {
  span: 'Span Fault',
  dt: 'DT Outage',
  feeder: 'Feeder Outage',
  sensor_fault: 'Sensor Fault',
};

const SIMULATOR_ACTIONABLE_STATUSES = new Set([
  'detected',
  'acknowledged',
  'crew_assigned',
  'resolved',
]);

const API_HEADERS = {
  'Content-Type': 'application/json',
};

export default function App() {
  const [theme, setTheme] = useState('dark');
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [selectedDtId, setSelectedDtId] = useState(null);
  const [selectedFeederId, setSelectedFeederId] = useState(null);
  const [selectedPoleId, setSelectedPoleId] = useState(null);
  const [incidentDetails, setIncidentDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [actionNotice, setActionNotice] = useState(null);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState(null);
  const [crewNote, setCrewNote] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');
  const [simulatorLoading, setSimulatorLoading] = useState(null);
  const [simulatorResult, setSimulatorResult] = useState(null);
  const lastDispatchAutoKeyRef = useRef(null);

  const incidentsPoll = usePolling(
    async () => {
      const payload = await fetchJson('/api/incidents');

      return payload.incidents ?? [];
    },
    4000,
    [],
  );
  const networkPoll = usePolling(
    () => fetchJson('/api/simulator/network'),
    5000,
    [],
  );

  const incidents = useMemo(
    () => sortIncidents(incidentsPoll.data ?? []),
    [incidentsPoll.data],
  );
  const network = networkPoll.data;
  const activeIncidents = useMemo(
    () => incidents.filter((incident) => incident.status !== 'closed'),
    [incidents],
  );
  const selectedIncident =
    incidents.find((incident) => incident.id === selectedIncidentId) ??
    activeIncidents[0] ??
    incidents[0] ??
    null;
  const selectedDetailIncident = incidentDetails?.incident ?? selectedIncident;
  const selectedIncidentPoles = incidentDetails?.incidentPoles ?? [];
  const networkStats = useMemo(() => buildNetworkStats(network), [network]);

  useEffect(() => {
    if (!selectedIncidentId && selectedIncident) {
      setSelectedIncidentId(selectedIncident.id);
    }
  }, [selectedIncident, selectedIncidentId]);

  useEffect(() => {
    if (!network) {
      return;
    }

    if (!selectedFeederId && network.feeders?.[0]) {
      setSelectedFeederId(network.feeders[0].feederId);
    }

    if (!selectedDtId && network.dts?.[0]) {
      setSelectedDtId(network.dts[0].dtId);
    }
  }, [network, selectedDtId, selectedFeederId]);

  useEffect(() => {
    if (!network || !selectedDtId) {
      return;
    }

    const dtPoles = getPolesForDt(network, selectedDtId);

    if (
      dtPoles.length > 0 &&
      !dtPoles.some((pole) => pole.poleId === selectedPoleId)
    ) {
      setSelectedPoleId(dtPoles[0].poleId);
    }
  }, [network, selectedDtId, selectedPoleId]);

  useEffect(() => {
    let cancelled = false;

    async function loadDetails() {
      if (!selectedIncidentId) {
        setIncidentDetails(null);
        return;
      }

      setDetailsLoading(true);

      try {
        const payload = await fetchJson(`/api/incidents/${selectedIncidentId}`);

        if (!cancelled) {
          setIncidentDetails(payload);
          setActionNotice(null);
        }
      } catch (error) {
        if (!cancelled) {
          setIncidentDetails(null);
          setActionNotice({
            tone: 'danger',
            message: error.message,
          });
        }
      } finally {
        if (!cancelled) {
          setDetailsLoading(false);
        }
      }
    }

    loadDetails();

    return () => {
      cancelled = true;
    };
  }, [selectedIncidentId, incidentsPoll.updatedAt]);

  const requestDispatchNote = useCallback(
    async ({ incidentId, regenerate = false, silent = false } = {}) => {
      const targetIncidentId = incidentId ?? selectedDetailIncident?.id;

      if (!targetIncidentId) {
        return null;
      }

      setDispatchLoading(true);

      if (!silent) {
        setDispatchNotice(null);
      }

      try {
        const result = await fetchJson(
          `/api/incidents/${targetIncidentId}/dispatch-note`,
          {
            method: 'POST',
            body: {
              regenerate,
            },
          },
        );

        setIncidentDetails((current) => {
          if (!current || current.incident?.id !== targetIncidentId) {
            return current;
          }

          return {
            ...current,
            incident: result.incident,
          };
        });

        if (!silent) {
          setDispatchNotice(formatDispatchNotice(result));
        }

        return result;
      } catch (error) {
        if (!silent) {
          setDispatchNotice({
            tone: 'danger',
            message: error.message,
          });
        }

        return null;
      } finally {
        setDispatchLoading(false);
      }
    },
    [selectedDetailIncident?.id],
  );

  useEffect(() => {
    if (!selectedDetailIncident?.id) {
      return;
    }

    const autoKey = buildDispatchAutoKey(selectedDetailIncident);

    if (lastDispatchAutoKeyRef.current === autoKey) {
      return;
    }

    lastDispatchAutoKeyRef.current = autoKey;
    void requestDispatchNote({
      incidentId: selectedDetailIncident.id,
      regenerate: false,
      silent: true,
    });
  }, [
    requestDispatchNote,
    selectedDetailIncident?.confidence,
    selectedDetailIncident?.id,
    selectedDetailIncident?.status,
    selectedDetailIncident?.topologySource,
  ]);

  async function refreshConsole() {
    await Promise.all([incidentsPoll.refetch(), networkPoll.refetch()]);

    if (selectedIncidentId) {
      const payload = await fetchJson(`/api/incidents/${selectedIncidentId}`);
      setIncidentDetails(payload);
    }
  }

  async function runWorkflowAction(actionPath) {
    if (!selectedDetailIncident) {
      return;
    }

    const payload =
      actionPath === 'assign-crew'
        ? { crewNote: crewNote.trim() }
        : actionPath === 'mark-resolved'
          ? { note: resolutionNote.trim() }
          : {};

    setActionLoading(actionPath);
    setActionNotice(null);

    try {
      const result = await fetchJson(
        `/api/incidents/${selectedDetailIncident.id}/${actionPath}`,
        {
          method: 'POST',
          body: payload,
        },
      );

      setIncidentDetails((current) => ({
        ...(current ?? {}),
        incident: result.incident,
      }));
      setActionNotice(formatWorkflowNotice(actionPath, result));
      setCrewNote('');
      setResolutionNote('');
      await refreshConsole();
    } catch (error) {
      setActionNotice({
        tone: 'danger',
        message: error.message,
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function runSimulatorAction(kind) {
    const request = buildSimulatorRequest({
      kind,
      selectedDtId,
      selectedFeederId,
      selectedPoleId,
      selectedIncidentId: selectedDetailIncident?.id ?? selectedIncidentId,
    });

    if (!request) {
      return;
    }

    setSimulatorLoading(kind);
    setSimulatorResult(null);

    try {
      const result = await fetchJson(request.path, {
        method: 'POST',
        body: request.body,
      });

      setSimulatorResult({
        tone: 'success',
        title: request.label,
        result,
      });
      await refreshConsole();
    } catch (error) {
      setSimulatorResult({
        tone: 'danger',
        title: request.label,
        message: error.message,
      });
    } finally {
      setSimulatorLoading(null);
    }
  }

  const handleMapPoleSelect = useCallback(({ poleId, dtId, feederId }) => {
    setSelectedPoleId(poleId);
    setSelectedDtId(dtId);
    setSelectedFeederId(feederId);
  }, []);

  return (
    <main className={`app ${theme}`}>
      <AmbientLighting />

      <TopNavigation
        theme={theme}
        onToggleTheme={() =>
          setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
        }
        activeIncidentCount={activeIncidents.length}
        liveDeviceCount={networkStats.liveDevices}
        totalDeviceCount={networkStats.totalDevices}
        lastTelemetryAt={networkStats.lastTelemetryAt}
        incidentsLoading={incidentsPoll.loading}
        networkLoading={networkPoll.loading}
      />

      <OperatorConsole
        network={network}
        networkStats={networkStats}
        activeIncidents={activeIncidents}
        selectedDetailIncident={selectedDetailIncident}
        selectedIncidentId={selectedIncidentId}
        selectedIncidentPoles={selectedIncidentPoles}
        selectedPoleId={selectedPoleId}
        selectedDtId={selectedDtId}
        selectedFeederId={selectedFeederId}
        incidentsLoading={incidentsPoll.loading}
        incidentsError={incidentsPoll.error}
        incidentDetails={incidentDetails}
        detailsLoading={detailsLoading}
        actionLoading={actionLoading}
        actionNotice={actionNotice}
        dispatchLoading={dispatchLoading}
        dispatchNotice={dispatchNotice}
        crewNote={crewNote}
        resolutionNote={resolutionNote}
        simulatorLoading={simulatorLoading}
        simulatorResult={simulatorResult}
        onSelectIncident={setSelectedIncidentId}
        onSelectPole={setSelectedPoleId}
        onMapPoleSelect={handleMapPoleSelect}
        onSelectDt={setSelectedDtId}
        onSelectFeeder={setSelectedFeederId}
        onCrewNoteChange={setCrewNote}
        onResolutionNoteChange={setResolutionNote}
        onAction={runWorkflowAction}
        onRepair={() => runSimulatorAction('repair')}
        onRegenerateDispatchNote={() =>
          requestDispatchNote({ regenerate: true })
        }
        onRunSimulator={runSimulatorAction}
      />
    </main>
  );
}

const CONSOLE_SECTIONS = ['dashboard', 'simulator', 'grid-health'];

export function OperatorConsole({
  network,
  networkStats,
  activeIncidents,
  selectedDetailIncident,
  selectedIncidentId,
  selectedIncidentPoles,
  selectedPoleId,
  selectedDtId,
  selectedFeederId,
  incidentsLoading,
  incidentsError,
  incidentDetails,
  detailsLoading,
  actionLoading,
  actionNotice,
  dispatchLoading,
  dispatchNotice,
  crewNote,
  resolutionNote,
  simulatorLoading,
  simulatorResult,
  onSelectIncident,
  onSelectPole,
  onMapPoleSelect,
  onSelectDt,
  onSelectFeeder,
  onCrewNoteChange,
  onResolutionNoteChange,
  onAction,
  onRepair,
  onRegenerateDispatchNote,
  onRunSimulator,
}) {
  return (
    <section className="console-shell" id="dashboard">
      <ConsoleHashScroller />

      <section className="operator-layout">
        <aside className="operator-left-column">
          <ConsoleSummary
            activeIncidentCount={activeIncidents.length}
            networkStats={networkStats}
          />

          <IncidentRail
            incidents={activeIncidents}
            selectedIncidentId={selectedDetailIncident?.id}
            loading={incidentsLoading}
            error={incidentsError}
            onSelectIncident={onSelectIncident}
          />

          <GridHealthPanel
            network={network}
            networkStats={networkStats}
            incidents={activeIncidents}
          />
        </aside>

        <section className="operator-right-column">
          <OperationsMap
            network={network}
            incidents={activeIncidents}
            selectedIncident={selectedDetailIncident}
            selectedIncidentPoles={selectedIncidentPoles}
            selectedPoleId={selectedPoleId}
            onSelectIncident={onSelectIncident}
            onSelectPole={onMapPoleSelect}
          />

          <SimulatorDock
            network={network}
            incidents={activeIncidents}
            selectedDtId={selectedDtId}
            selectedFeederId={selectedFeederId}
            selectedPoleId={selectedPoleId}
            selectedIncidentId={
              selectedDetailIncident?.id ?? selectedIncidentId
            }
            loading={simulatorLoading}
            result={simulatorResult}
            onSelectDt={onSelectDt}
            onSelectFeeder={onSelectFeeder}
            onSelectPole={onSelectPole}
            onSelectIncident={onSelectIncident}
            onRun={onRunSimulator}
          />

          <IncidentDetailPanel
            incident={selectedDetailIncident}
            incidentPoles={selectedIncidentPoles}
            incidentEvents={incidentDetails?.incidentEvents ?? []}
            loading={detailsLoading}
            actionLoading={actionLoading}
            actionNotice={actionNotice}
            dispatchLoading={dispatchLoading}
            dispatchNotice={dispatchNotice}
            crewNote={crewNote}
            resolutionNote={resolutionNote}
            onCrewNoteChange={onCrewNoteChange}
            onResolutionNoteChange={onResolutionNoteChange}
            onAction={onAction}
            onRepair={onRepair}
            onRegenerateDispatchNote={onRegenerateDispatchNote}
          />
        </section>
      </section>
    </section>
  );
}

export function ConsoleHashScroller() {
  useEffect(() => {
    function scrollToHash() {
      const sectionId = getActiveHashSection();
      window.requestAnimationFrame(() => {
        const section = document.getElementById(sectionId);

        if (!section) {
          return;
        }

        if (sectionId === 'dashboard') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }

        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);

    return () => window.removeEventListener('hashchange', scrollToHash);
  }, []);

  return null;
}

export function ConsoleSummary({ activeIncidentCount, networkStats }) {
  const livePercent =
    networkStats.totalDevices > 0
      ? Math.round((networkStats.liveDevices / networkStats.totalDevices) * 100)
      : 0;

  return (
    <section className="summary-grid" aria-label="Grid summary">
      <SummaryCard
        label="Active Incidents"
        value={activeIncidentCount}
        tone={activeIncidentCount > 0 ? 'danger' : 'success'}
        detail="Open events requiring operator attention"
      />
      <SummaryCard
        label="Health"
        value={`${livePercent}%`}
        tone={livePercent > 95 ? 'success' : 'warning'}
        detail={`${networkStats.liveDevices}/${networkStats.totalDevices} reporting live`}
      />
      <SummaryCard
        label="Dark Devices"
        value={networkStats.darkDevices}
        tone={networkStats.darkDevices > 0 ? 'danger' : 'success'}
        detail="Currently reporting de-energized"
      />
      <SummaryCard
        label="No Sensor"
        value={networkStats.noSensorPoles}
        detail="Poles without live telemetry devices"
      />
      <SummaryCard
        label="Last Telemetry"
        value={formatRelativeTime(networkStats.lastTelemetryAt)}
        detail="Most recent device heartbeat"
      />
    </section>
  );
}

export function SummaryCard({ label, value, detail, tone = 'neutral' }) {
  return (
    <article className={`summary-card ${tone}`}>
      <p className="eyebrow">{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

export function AmbientLighting() {
  return (
    <>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="grid-texture" />
    </>
  );
}

export function TopNavigation({
  theme,
  onToggleTheme,
  activeIncidentCount,
  liveDeviceCount,
  totalDeviceCount,
  lastTelemetryAt,
  incidentsLoading,
  networkLoading,
}) {
  const activeSection = useActiveHashSection();

  return (
    <header className="top-nav glass-panel">
      <div className="brand-lockup">
        <div className="brand-mark">ϟ</div>
        <div>
          <p className="eyebrow">KSPDB Control Room</p>
          <h1>ElecSense</h1>
        </div>
      </div>

      <nav className="nav-pills" aria-label="Primary">
        <HashTab href="#dashboard" active={activeSection === 'dashboard'}>
          Dashboard
        </HashTab>
        <HashTab href="#simulator" active={activeSection === 'simulator'}>
          Simulator
        </HashTab>
        <HashTab href="#grid-health" active={activeSection === 'grid-health'}>
          Grid Health
        </HashTab>
      </nav>

      <div className="nav-metrics">
        <MetricChip
          label="Live Devices"
          value={`${liveDeviceCount}/${totalDeviceCount}`}
          pulse={networkLoading}
        />
        <MetricChip
          label="Active Incidents"
          value={activeIncidentCount}
          alert={activeIncidentCount > 0}
          pulse={incidentsLoading}
        />
        <MetricChip
          label="Last Telemetry"
          value={formatRelativeTime(lastTelemetryAt)}
        />
      </div>

      <button className="theme-toggle" type="button" onClick={onToggleTheme}>
        <span>{theme === 'dark' ? '☾' : '☀'}</span>
        {theme === 'dark' ? 'Dark' : 'Light'}
      </button>
    </header>
  );
}

export function HashTab({ href, active, children }) {
  return (
    <a className={active ? 'active' : ''} href={href}>
      {children}
    </a>
  );
}

export function MetricChip({ label, value, alert = false, pulse = false }) {
  return (
    <div className={`metric-chip ${alert ? 'alert' : ''}`}>
      <span className={`metric-dot ${pulse ? 'pulse' : ''}`} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function OperationsMap({
  network,
  incidents,
  selectedIncident,
  selectedIncidentPoles,
  selectedPoleId,
  onSelectIncident,
  onSelectPole,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const hasFitBoundsRef = useRef(false);
  const [leafletReady, setLeafletReady] = useState(() => Boolean(window.L));

  useEffect(() => {
    if (window.L) {
      setLeafletReady(true);
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (window.L) {
        setLeafletReady(true);
        window.clearInterval(timer);
      }
    }, 80);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!leafletReady || !containerRef.current || mapRef.current) {
      return undefined;
    }

    const L = window.L;
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    }).setView([12.9716, 77.5946], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map);
    L.control
      .attribution({
        position: 'bottomright',
        prefix: false,
      })
      .addAttribution('© OpenStreetMap')
      .addTo(map);
    L.control
      .zoom({
        position: 'bottomright',
      })
      .addTo(map);

    layersRef.current = {
      feeders: L.layerGroup().addTo(map),
      poles: L.layerGroup().addTo(map),
      dts: L.layerGroup().addTo(map),
      incidents: L.layerGroup().addTo(map),
      selected: L.layerGroup().addTo(map),
    };
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
      hasFitBoundsRef.current = false;
    };
  }, [leafletReady]);

  useEffect(() => {
    if (!leafletReady || !containerRef.current || !mapRef.current) {
      return undefined;
    }

    let frameId = null;
    const scheduleSizeRefresh = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        mapRef.current?.invalidateSize();
      });
    };

    scheduleSizeRefresh();

    if (!window.ResizeObserver) {
      return () => {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }

    const resizeObserver = new window.ResizeObserver(scheduleSizeRefresh);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [leafletReady]);

  useEffect(() => {
    if (!leafletReady || !mapRef.current || !layersRef.current || !network) {
      return;
    }

    const L = window.L;
    const map = mapRef.current;
    const layers = layersRef.current;
    const poleById = new Map(network.poles.map((pole) => [pole.poleId, pole]));
    const selectedPoleIds = new Set(
      selectedIncidentPoles.map((pole) => pole.poleId),
    );

    Object.values(layers).forEach((layer) => layer.clearLayers());

    for (const pole of network.poles) {
      const parent = pole.trueParentPoleId
        ? poleById.get(pole.trueParentPoleId)
        : null;

      if (!parent) {
        continue;
      }

      L.polyline(
        [
          [Number(parent.lat), Number(parent.lon)],
          [Number(pole.lat), Number(pole.lon)],
        ],
        {
          color: 'rgba(94, 162, 255, 0.22)',
          weight: 1.1,
          opacity: 0.65,
          interactive: false,
        },
      ).addTo(layers.feeders);
    }

    for (const pole of network.poles) {
      const state = getPoleState(pole);
      const selected = pole.poleId === selectedPoleId;
      const affected = selectedPoleIds.has(pole.poleId);
      const marker = L.circleMarker([Number(pole.lat), Number(pole.lon)], {
        radius: selected ? 7 : affected ? 5 : 3,
        color: selected
          ? '#5EA2FF'
          : affected
            ? '#FF4D6D'
            : getDeviceColor(state),
        weight: selected || affected ? 2 : 1,
        fillColor: getDeviceColor(state),
        fillOpacity: affected ? 0.95 : 0.72,
        opacity: selected || affected ? 1 : 0.62,
      });

      marker.bindTooltip(
        `${pole.poleId} · ${pole.dtId} · ${formatPoleState(state)}`,
        {
          direction: 'top',
          opacity: 0.92,
        },
      );
      marker.on('click', () =>
        onSelectPole({
          poleId: pole.poleId,
          dtId: pole.dtId,
          feederId: pole.feederId,
        }),
      );
      marker.addTo(layers.poles);
    }

    for (const dt of network.dts) {
      L.marker([Number(dt.lat), Number(dt.lon)], {
        icon: L.divIcon({
          className: 'dt-div-icon',
          html: `<span>${dt.dtId.replace('DT-', '')}</span>`,
          iconSize: [42, 42],
          iconAnchor: [21, 21],
        }),
      })
        .bindTooltip(`${dt.dtId} · ${dt.poleCount} poles`)
        .addTo(layers.dts);
    }

    for (const incident of incidents) {
      if (!incident.lat || !incident.lon) {
        continue;
      }

      const selected = incident.id === selectedIncident?.id;
      const marker = L.circleMarker(
        [Number(incident.lat), Number(incident.lon)],
        {
          radius: selected ? 18 : 9,
          color: getStatusColor(incident.status),
          weight: selected ? 3 : 1.5,
          fillColor: getStatusColor(incident.status),
          fillOpacity: selected ? 0.28 : 0.14,
          opacity: selected ? 1 : 0.74,
        },
      );

      marker.on('click', () => onSelectIncident(incident.id));
      marker.addTo(layers.incidents);
    }

    if (selectedIncident?.lat && selectedIncident?.lon) {
      const selectedLatLng = [
        Number(selectedIncident.lat),
        Number(selectedIncident.lon),
      ];

      L.marker(selectedLatLng, {
        icon: L.divIcon({
          className: 'selected-incident-pulse',
          html: '<span></span>',
          iconSize: [56, 56],
          iconAnchor: [28, 28],
        }),
      }).addTo(layers.selected);

      const boundaryPole = selectedIncident.boundaryPoleId
        ? poleById.get(selectedIncident.boundaryPoleId)
        : null;
      const boundaryParent = selectedIncident.boundaryParentId
        ? poleById.get(selectedIncident.boundaryParentId)
        : null;

      if (boundaryPole && boundaryParent) {
        L.polyline(
          [
            [Number(boundaryParent.lat), Number(boundaryParent.lon)],
            [Number(boundaryPole.lat), Number(boundaryPole.lon)],
          ],
          {
            color: '#FF4D6D',
            weight: 6,
            opacity: 0.92,
            className: 'fault-span-line',
          },
        ).addTo(layers.selected);
      }
    }

    const bounds = network.poles.map((pole) => [
      Number(pole.lat),
      Number(pole.lon),
    ]);

    if (!hasFitBoundsRef.current && bounds.length > 0) {
      map.fitBounds(bounds, {
        paddingTopLeft: [48, 120],
        paddingBottomRight: [48, 88],
        maxZoom: 14,
      });
      hasFitBoundsRef.current = true;
    }
  }, [
    incidents,
    leafletReady,
    network,
    onSelectIncident,
    onSelectPole,
    selectedIncident,
    selectedIncidentPoles,
    selectedPoleId,
  ]);

  useEffect(() => {
    if (!mapRef.current || !selectedIncident?.lat || !selectedIncident?.lon) {
      return;
    }

    mapRef.current.flyTo(
      [Number(selectedIncident.lat), Number(selectedIncident.lon)],
      16,
      {
        duration: 0.9,
      },
    );
  }, [selectedIncident?.id, selectedIncident?.lat, selectedIncident?.lon]);

  return (
    <section className="map-shell" id="distribution-map">
      <div className="map-chrome">
        <div>
          <p className="eyebrow">Live distribution map</p>
          <h2>Network Operations Console</h2>
        </div>
        <div className="map-legend">
          <LegendItem color="#33D17A" label="Live" />
          <LegendItem color="#FF4D6D" label="Dark" />
          <LegendItem color="#6B7280" label="No sensor" />
        </div>
      </div>

      <div className="leaflet-host" ref={containerRef}>
        {!leafletReady && (
          <div className="map-loading">
            <span className="spinner" />
            Loading Leaflet map…
          </div>
        )}
      </div>
    </section>
  );
}

export function LegendItem({ color, label }) {
  return (
    <span className="legend-item">
      <i style={{ '--legend-color': color }} />
      {label}
    </span>
  );
}

export function IncidentRail({
  incidents,
  selectedIncidentId,
  loading,
  error,
  onSelectIncident,
}) {
  return (
    <aside className="incident-rail glass-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Active Incidents</p>
          <h2>{incidents.length} open events</h2>
        </div>
        <span className={`live-badge ${loading ? 'pulse' : ''}`}>Live</span>
      </div>

      {error && <div className="notice danger">{error.message}</div>}

      <div className="incident-list">
        {loading && incidents.length === 0
          ? Array.from({ length: 4 }, (_, index) => (
              <div className="incident-card skeleton" key={index} />
            ))
          : null}

        {!loading && incidents.length === 0 ? (
          <div className="empty-state">
            <span>✓</span>
            <strong>No active incidents</strong>
            <p>The grid is quiet. A rare and suspiciously pleasant moment.</p>
          </div>
        ) : null}

        {incidents.map((incident) => (
          <button
            className={`incident-card ${
              selectedIncidentId === incident.id ? 'selected' : ''
            }`}
            type="button"
            key={incident.id}
            onClick={() => onSelectIncident(incident.id)}
          >
            <div className="card-row">
              <StatusPill status={incident.status} />
              <span className="confidence">
                {toPercent(incident.confidence)}
              </span>
            </div>
            <h3>{formatIncidentType(incident.type)}</h3>
            <div className="incident-card-grid">
              <span>Affected</span>
              <strong>{incident.affectedPoleCount} poles</strong>
              <span>Pincode</span>
              <strong>{incident.pincode ?? '—'}</strong>
              <span>Detected</span>
              <strong>{formatRelativeTime(incident.detectedAt)}</strong>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function IncidentDetailPanel({
  incident,
  incidentPoles,
  incidentEvents,
  loading,
  actionLoading,
  actionNotice,
  dispatchLoading,
  dispatchNotice,
  crewNote,
  resolutionNote,
  onCrewNoteChange,
  onResolutionNoteChange,
  onAction,
  onRepair,
  onRegenerateDispatchNote,
}) {
  const statusMeta = incident ? STATUS_META[incident.status] : null;
  const showCrewNote = incident?.status === 'acknowledged';
  const showResolutionNote = incident?.status === 'crew_assigned';
  const timelineEvents = useMemo(
    () => buildOperatorTimeline(incidentEvents, incident),
    [incident, incidentEvents],
  );

  return (
    <aside className="detail-panel glass-panel">
      {!incident ? (
        <div className="empty-state detail-empty">
          <span>⌁</span>
          <strong>Select an incident</strong>
          <p>Click a card or a glowing fault marker to inspect the event.</p>
        </div>
      ) : (
        <>
          <div className="detail-hero">
            <div>
              <p className="eyebrow">Incident Details</p>
              <h2>{formatIncidentType(incident.type)}</h2>
            </div>
            <StatusPill status={incident.status} />
          </div>

          {loading ? <div className="detail-loading shimmer" /> : null}

          {incident.topologySource === 'inferred' ? (
            <div className="notice warning">
              Inferred topology: localization confidence includes an MST wiring
              penalty. Verify field topology before dispatching high-risk work.
            </div>
          ) : null}

          {incident.telemetryDisagrees ? (
            <div className="notice danger">
              Telemetry disagreement: one or more affected poles are still not
              reporting live after human resolution.
            </div>
          ) : null}

          {actionNotice ? (
            <div className={`notice ${actionNotice.tone}`}>
              {actionNotice.message}
            </div>
          ) : null}

          {dispatchNotice ? (
            <div className={`notice ${dispatchNotice.tone}`}>
              {dispatchNotice.message}
            </div>
          ) : null}

          <section className="detail-section location-card">
            <div>
              <span className="section-icon">⌖</span>
              <p>Location</p>
              <strong>
                {incident.dtId ?? incident.feederId} ·{' '}
                {incident.pincode ?? 'No pincode'}
              </strong>
            </div>
            <div>
              <p>Coordinates</p>
              <strong>{formatCoordinates(incident.lat, incident.lon)}</strong>
            </div>
          </section>

          <section className="metric-grid">
            <DetailMetric
              label="Affected Poles"
              value={incident.affectedPoleCount}
            />
            <DetailMetric
              label="Confidence"
              value={toPercent(incident.confidence)}
            />
            <DetailMetric
              label="Topology"
              value={capitalize(incident.topologySource)}
            />
            <DetailMetric
              label="Boundary"
              value={incident.boundaryPoleId ?? 'Transformer'}
            />
          </section>

          <section className="detail-section dispatch-note-card">
            <div className="section-title-row">
              <div>
                <p className="section-label">Field Dispatch Note</p>
                <span className="dispatch-source">
                  {formatDispatchSource(incident.dispatchNoteSource)}
                </span>
              </div>
              <button
                className="mini-action"
                type="button"
                disabled={dispatchLoading}
                onClick={onRegenerateDispatchNote}
              >
                {dispatchLoading ? <span className="spinner small" /> : '↻'}
                {incident.dispatchNote ? 'Regenerate' : 'Generate'}
              </button>
            </div>
            <p className="dispatch-note-copy">
              {incident.dispatchNote ??
                'Generating a crew-ready note from the deterministic incident summary…'}
            </p>
            <p className="dispatch-disclaimer">
              Auto-generated from computed incident data only. Verify before
              dispatch.
            </p>
          </section>

          <section className="detail-section">
            <p className="section-label">Confidence Reason</p>
            <p className="reason-copy">{incident.confidenceReason}</p>
          </section>

          <section className="detail-section">
            <div className="section-title-row">
              <p className="section-label">Incident Timeline</p>
              <span>{timelineEvents.length} milestones</span>
            </div>
            <div className="timeline">
              {timelineEvents.length === 0 ? (
                <p className="muted">No timeline events loaded yet.</p>
              ) : (
                timelineEvents.map((event) => (
                  <div className="timeline-item" key={event.id}>
                    <span />
                    <div>
                      <strong>{event.label}</strong>
                      <p>{formatRelativeTime(event.createdAt)}</p>
                      {event.details.length > 0 ? (
                        <div className="timeline-details">
                          {event.details.map((detail, index) => (
                            <small key={`${detail}-${index}`}>{detail}</small>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="detail-section actions-section">
            <p className="section-label">Operator Actions</p>

            {showCrewNote ? (
              <textarea
                className="operator-note"
                placeholder="Crew note, e.g. Field crew Alpha dispatched…"
                value={crewNote}
                onChange={(event) => onCrewNoteChange(event.target.value)}
              />
            ) : null}

            {showResolutionNote ? (
              <textarea
                className="operator-note"
                placeholder="Resolution note, e.g. Fuse replaced at branch isolator…"
                value={resolutionNote}
                onChange={(event) => onResolutionNoteChange(event.target.value)}
              />
            ) : null}

            <div className="action-row">
              {statusMeta?.actionPath ? (
                <button
                  className="primary-action"
                  type="button"
                  disabled={actionLoading !== null}
                  onClick={() => onAction(statusMeta.actionPath)}
                >
                  {actionLoading === statusMeta.actionPath ? (
                    <span className="spinner small" />
                  ) : (
                    <span>↗</span>
                  )}
                  {statusMeta.actionLabel}
                </button>
              ) : null}

              {incident.status !== 'closed' ? (
                <button
                  className="secondary-action"
                  type="button"
                  onClick={onRepair}
                >
                  <span>↻</span>
                  Repair Telemetry
                </button>
              ) : null}
            </div>

            {incident.status === 'resolved' ? (
              <p className="muted">
                Waiting for the detection loop to auto-verify once all affected
                poles report live.
              </p>
            ) : null}
          </section>

          <section className="detail-section affected-strip">
            <p className="section-label">Affected Devices</p>
            <div>
              {incidentPoles.slice(0, 10).map((pole) => (
                <span
                  className={`device-chip ${getPoleState({ current: pole })}`}
                  key={pole.poleId}
                >
                  {pole.poleId}
                </span>
              ))}
              {incidentPoles.length > 10 ? (
                <span className="device-chip muted-chip">
                  +{incidentPoles.length - 10}
                </span>
              ) : null}
            </div>
          </section>
        </>
      )}
    </aside>
  );
}

export function DetailMetric({ label, value }) {
  return (
    <div className="detail-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function GridHealthPanel({ network, networkStats, incidents }) {
  const feederSummaries = useMemo(
    () => buildFeederSummaries(network, incidents),
    [incidents, network],
  );
  const dtCount = network?.dts?.length ?? 0;
  const livePercent =
    networkStats.totalDevices > 0
      ? Math.round((networkStats.liveDevices / networkStats.totalDevices) * 100)
      : 0;

  return (
    <aside className="grid-health-panel glass-panel" id="grid-health">
      <div className="detail-hero">
        <div>
          <p className="eyebrow">Grid Health</p>
          <h2>Feeder Telemetry Status</h2>
        </div>
        <span className="engineering-chip">{livePercent}% Live</span>
      </div>

      <section className="metric-grid health-metric-grid">
        <DetailMetric label="Feeders" value={network?.feeders?.length ?? 0} />
        <DetailMetric label="Transformers" value={dtCount} />
        <DetailMetric label="Live Devices" value={networkStats.liveDevices} />
        <DetailMetric label="Dark Devices" value={networkStats.darkDevices} />
        <DetailMetric label="No Sensor" value={networkStats.noSensorPoles} />
        <DetailMetric
          label="Last Telemetry"
          value={formatRelativeTime(networkStats.lastTelemetryAt)}
        />
      </section>

      <section className="detail-section feeder-health-card">
        <div className="section-title-row">
          <p className="section-label">Feeder Breakdown</p>
          <span>{feederSummaries.length} feeders</span>
        </div>

        <div className="feeder-health-list">
          {feederSummaries.map((feeder) => (
            <div className="feeder-health-row" key={feeder.feederId}>
              <div>
                <strong>{feeder.feederId}</strong>
                <p>
                  {feeder.liveDevices}/{feeder.deviceCount} live devices ·{' '}
                  {feeder.poleCount} poles
                </p>
              </div>
              <span className={feeder.activeIncidents > 0 ? 'alert' : ''}>
                {feeder.activeIncidents} active
              </span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

export function SimulatorDock({
  network,
  incidents,
  selectedDtId,
  selectedFeederId,
  selectedPoleId,
  selectedIncidentId,
  loading,
  result,
  onSelectDt,
  onSelectFeeder,
  onSelectPole,
  onSelectIncident,
  onRun,
}) {
  const dtPoles = useMemo(
    () => (network && selectedDtId ? getPolesForDt(network, selectedDtId) : []),
    [network, selectedDtId],
  );
  const actionableIncidents = useMemo(
    () => buildSimulatorIncidentOptions(incidents),
    [incidents],
  );
  const selectedActionableIncidentId = actionableIncidents.some(
    (incident) => incident.id === selectedIncidentId,
  )
    ? selectedIncidentId
    : '';

  return (
    <section className="simulator-dock glass-panel" id="simulator">
      <div className="simulator-header">
        <div>
          <p className="eyebrow">Simulator</p>
          <h2>Fault Injection Rig</h2>
        </div>
        <span className="engineering-chip">Live API Path</span>
      </div>

      <div className="simulator-workflows">
        <section className="simulator-workflow create-fault-workflow">
          <div className="workflow-heading">
            <p className="section-label">Create New Fault</p>
            <span>Simulate a new outage or sensor condition</span>
          </div>

          <div className="simulator-selects create-fault-selects">
            <label>
              Feeder
              <select
                value={selectedFeederId ?? ''}
                onChange={(event) => onSelectFeeder(event.target.value)}
              >
                {(network?.feeders ?? []).map((feeder) => (
                  <option key={feeder.feederId} value={feeder.feederId}>
                    {feeder.feederId}
                  </option>
                ))}
              </select>
            </label>

            <label>
              DT
              <select
                value={selectedDtId ?? ''}
                onChange={(event) => onSelectDt(event.target.value)}
              >
                {(network?.dts ?? []).map((dt) => (
                  <option key={dt.dtId} value={dt.dtId}>
                    {dt.dtId} · {dt.poleCount}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Pole
              <select
                value={selectedPoleId ?? ''}
                onChange={(event) => onSelectPole(event.target.value)}
              >
                {dtPoles.map((pole) => (
                  <option key={pole.poleId} value={pole.poleId}>
                    {pole.poleId}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="simulator-actions create-fault-actions">
            <SimulatorButton
              icon="⚡"
              label="Inject Span Fault"
              kind="span"
              loading={loading}
              disabled={!selectedDtId || !selectedPoleId}
              onRun={onRun}
            />
            <SimulatorButton
              icon="⌁"
              label="DT Fault"
              kind="dt"
              loading={loading}
              disabled={!selectedDtId}
              onRun={onRun}
            />
            <SimulatorButton
              icon="⎋"
              label="Feeder Fault"
              kind="feeder"
              loading={loading}
              disabled={!selectedFeederId}
              onRun={onRun}
            />
            <SimulatorButton
              icon="⊘"
              label="Dead Sensor"
              kind="dead-sensor"
              loading={loading}
              disabled={!selectedPoleId}
              onRun={onRun}
            />
          </div>
        </section>

        <section className="simulator-workflow manage-incident-workflow">
          <div className="workflow-heading">
            <p className="section-label">Manage Existing Incident</p>
            <span>Operate on an incident that already exists</span>
          </div>

          <div className="simulator-selects manage-incident-selects">
            <label>
              Incident
              <select
                value={selectedActionableIncidentId}
                onChange={(event) => onSelectIncident(event.target.value)}
              >
                <option value="" disabled>
                  Select actionable incident
                </option>
                {actionableIncidents.map((incident) => (
                  <option key={incident.id} value={incident.id}>
                    {formatIncidentCode(incident)} ·{' '}
                    {formatIncidentType(incident.type)} ·{' '}
                    {incident.dtId ?? incident.feederId ?? 'Grid'} ·{' '}
                    {STATUS_META[incident.status]?.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="simulator-actions manage-incident-actions">
            <SimulatorButton
              icon="↻"
              label="Repair"
              kind="repair"
              loading={loading}
              disabled={!selectedActionableIncidentId}
              onRun={onRun}
            />
          </div>
        </section>
      </div>

      {result ? (
        <div className={`simulator-result ${result.tone}`}>
          <strong>{result.title}</strong>
          <p>{result.message ?? summarizeSimulatorResult(result.result)}</p>
        </div>
      ) : null}
    </section>
  );
}

export function SimulatorButton({
  icon,
  label,
  kind,
  loading,
  disabled,
  onRun,
}) {
  const active = loading === kind;

  return (
    <button
      className="simulator-button"
      type="button"
      disabled={disabled || loading !== null}
      onClick={() => onRun(kind)}
    >
      {active ? <span className="spinner small" /> : <span>{icon}</span>}
      {label}
    </button>
  );
}

export function StatusPill({ status }) {
  const meta = STATUS_META[status] ?? {
    label: capitalize(status),
    tone: 'closed',
  };

  return <span className={`status-pill ${meta.tone}`}>{meta.label}</span>;
}

function buildSimulatorRequest({
  kind,
  selectedDtId,
  selectedFeederId,
  selectedPoleId,
  selectedIncidentId,
}) {
  const requests = {
    span: {
      label: 'Span Fault Injected',
      path: '/api/simulator/span-fault',
      body: {
        dtId: selectedDtId,
        atPoleId: selectedPoleId,
      },
    },
    dt: {
      label: 'DT Fault Injected',
      path: '/api/simulator/dt-fault',
      body: {
        dtId: selectedDtId,
      },
    },
    feeder: {
      label: 'Feeder Fault Injected',
      path: '/api/simulator/feeder-fault',
      body: {
        feederId: selectedFeederId,
      },
    },
    'dead-sensor': {
      label: 'Dead Sensor Simulated',
      path: '/api/simulator/dead-sensor',
      body: {
        poleId: selectedPoleId,
      },
    },
    repair: {
      label: 'Repair Telemetry Sent',
      path: `/api/simulator/repair/${selectedIncidentId}`,
      body: {},
    },
  };

  return requests[kind] ?? null;
}

function formatWorkflowNotice(actionPath, result) {
  if (actionPath === 'mark-resolved' && result.telemetryMismatch) {
    return {
      tone: 'warning',
      message: result.message,
    };
  }

  return {
    tone: 'success',
    message: `Incident moved to ${STATUS_META[result.incident.status]?.label}.`,
  };
}

function formatDispatchNotice(result) {
  if (result.source === 'template-fallback') {
    return {
      tone: 'warning',
      message:
        'Dispatch note generated from the local fallback template because the LLM was unavailable.',
    };
  }

  return {
    tone: 'success',
    message: result.reused
      ? 'Stored dispatch note is still current.'
      : 'Dispatch note regenerated with the LLM.',
  };
}

function buildDispatchAutoKey(incident) {
  return [
    incident.id,
    incident.status,
    incident.confidence,
    incident.topologySource,
  ].join(':');
}

function formatDispatchSource(source) {
  if (source === 'llm') {
    return 'LLM-generated · verify before dispatch';
  }

  if (source === 'template-fallback') {
    return 'Template fallback · verify before dispatch';
  }

  return 'Pending generation';
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: API_HEADERS,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? response.statusText);
  }

  return payload;
}

function sortIncidents(incidents) {
  return [...incidents].sort((left, right) => {
    const leftPriority = STATUS_META[left.status]?.priority ?? 99;
    const rightPriority = STATUS_META[right.status]?.priority ?? 99;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    if (left.affectedPoleCount !== right.affectedPoleCount) {
      return right.affectedPoleCount - left.affectedPoleCount;
    }

    return new Date(right.detectedAt) - new Date(left.detectedAt);
  });
}

function buildSimulatorIncidentOptions(incidents) {
  const incidentList = incidents ?? [];
  const incidentCodes = buildIncidentCodeMap(incidentList);

  return incidentList
    .filter((incident) => SIMULATOR_ACTIONABLE_STATUSES.has(incident.status))
    .map((incident) => ({
      ...incident,
      simulatorIncidentCode: incidentCodes.get(incident.id),
    }))
    .sort((left, right) => {
      const leftPriority = STATUS_META[left.status]?.priority ?? 99;
      const rightPriority = STATUS_META[right.status]?.priority ?? 99;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return new Date(left.detectedAt) - new Date(right.detectedAt);
    });
}

function buildIncidentCodeMap(incidents) {
  const incidentList = incidents ?? [];

  return new Map(
    [...incidentList]
      .sort(
        (left, right) => new Date(left.detectedAt) - new Date(right.detectedAt),
      )
      .map((incident, index) => [
        incident.id,
        formatIncidentOrdinal(index + 1),
      ]),
  );
}

function formatIncidentCode(incident) {
  return (
    incident.incidentCode ??
    incident.code ??
    incident.simulatorIncidentCode ??
    'INC-???'
  );
}

function formatIncidentOrdinal(value) {
  return `INC-${String(value).padStart(3, '0')}`;
}

function buildOperatorTimeline(events, incident) {
  const timeline = [];
  const localizationEvents = [];
  let detectedEvent = null;

  for (const event of events ?? []) {
    if (event.eventType === 'localization_updated') {
      localizationEvents.push(event);
      continue;
    }

    const normalizedEvent = normalizeTimelineEvent(event);

    if (normalizedEvent) {
      timeline.push(normalizedEvent);
    }

    if (event.eventType === 'detected') {
      detectedEvent = event;
    }
  }

  if (localizationEvents.length > 0) {
    timeline.push(buildLocalizationTimelineEvent(localizationEvents, incident));
  } else if (detectedEvent?.payload?.incident) {
    timeline.push(
      buildInitialLocalizationTimelineEvent(detectedEvent, incident),
    );
  }

  return timeline.sort((left, right) => {
    const leftOrder = left.order ?? 99;
    const rightOrder = right.order ?? 99;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return new Date(left.createdAt) - new Date(right.createdAt);
  });
}

function normalizeTimelineEvent(event) {
  if (event.eventType === 'detected') {
    return {
      id: event.id,
      label: 'Detected',
      createdAt: event.createdAt,
      order: 0,
      details: buildDetectionDetails(event),
    };
  }

  if (event.eventType === 'dispatch_note_generated') {
    return {
      id: event.id,
      label: 'Dispatch Note Generated',
      createdAt: event.createdAt,
      order: 2,
      details: [formatDispatchSource(event.payload?.source)].filter(Boolean),
    };
  }

  if (event.eventType === 'status_changed') {
    const toStatus = event.payload?.toStatus;

    return {
      id: event.id,
      label: formatTimelineStatus(toStatus),
      createdAt: event.payload?.changedAt ?? event.createdAt,
      order: getTimelineStatusOrder(toStatus),
      details: buildStatusChangeDetails(event),
    };
  }

  if (event.eventType === 'auto_verified') {
    return {
      id: event.id,
      label: 'Verified',
      createdAt: event.payload?.verifiedAt ?? event.createdAt,
      order: 6,
      details: [event.payload?.reason].filter(Boolean),
    };
  }

  if (event.eventType === 'scope_downgraded') {
    return {
      id: event.id,
      label: 'Verified',
      createdAt: event.payload?.downgradedAt ?? event.createdAt,
      order: 6,
      details: [event.payload?.reason].filter(Boolean),
    };
  }

  return null;
}

function buildInitialLocalizationTimelineEvent(detectedEvent, incident) {
  const detectedIncident = detectedEvent.payload?.incident ?? {};
  const confidence = detectedIncident.confidence ?? incident?.confidence;
  const affectedPoleCount =
    detectedIncident.affectedPoleCount ?? incident?.affectedPoleCount;
  const boundary = detectedIncident.boundaryPoleId ?? incident?.boundaryPoleId;
  const details = [
    confidence !== undefined ? `Confidence: ${toPercent(confidence)}` : null,
    affectedPoleCount !== undefined
      ? `${affectedPoleCount} affected poles`
      : null,
    boundary ? `Boundary: ${boundary}` : null,
  ].filter(Boolean);

  return {
    id: `localization-established-${detectedEvent.id}`,
    label: 'Localization Established',
    createdAt: detectedEvent.createdAt,
    order: 1,
    details,
  };
}

function buildLocalizationTimelineEvent(localizationEvents, incident) {
  const latestEvent = localizationEvents.reduce((latest, event) =>
    new Date(event.createdAt) > new Date(latest.createdAt) ? event : latest,
  );
  const latestIncident = latestEvent.payload?.incident ?? {};
  const confidence = latestIncident.confidence ?? incident?.confidence;
  const affectedPoleCount =
    latestIncident.affectedPoleCount ?? incident?.affectedPoleCount;
  const boundary = latestIncident.boundaryPoleId ?? incident?.boundaryPoleId;
  const details = [
    confidence !== undefined ? `Confidence: ${toPercent(confidence)}` : null,
    affectedPoleCount !== undefined
      ? `${affectedPoleCount} affected poles`
      : null,
    boundary ? `Boundary: ${boundary}` : null,
    `Last update: ${formatRelativeTime(
      latestEvent.payload?.updatedAt ?? latestEvent.createdAt,
    )}`,
    localizationEvents.length > 1
      ? `${localizationEvents.length} localization updates collapsed`
      : null,
  ].filter(Boolean);

  return {
    id: `localization-${latestEvent.id}`,
    label:
      localizationEvents.length > 1
        ? 'Localization Updated'
        : 'Localization Established',
    createdAt: latestEvent.payload?.updatedAt ?? latestEvent.createdAt,
    order: 1,
    details,
  };
}

function buildDetectionDetails(event) {
  const detectedIncident = event.payload?.incident;

  return [
    detectedIncident?.confidence !== undefined
      ? `Initial confidence: ${toPercent(detectedIncident.confidence)}`
      : null,
    detectedIncident?.affectedPoleCount !== undefined
      ? `${detectedIncident.affectedPoleCount} affected poles`
      : null,
  ].filter(Boolean);
}

function buildStatusChangeDetails(event) {
  const details = [];

  if (event.payload?.fromStatus && event.payload?.toStatus) {
    details.push(
      `${formatTimelineStatus(event.payload.fromStatus)} → ${formatTimelineStatus(
        event.payload.toStatus,
      )}`,
    );
  }

  if (event.payload?.crewNote) {
    details.push(event.payload.crewNote);
  }

  if (event.payload?.note) {
    details.push(event.payload.note);
  }

  return details;
}

function formatTimelineStatus(status) {
  const labels = {
    detected: 'Detected',
    acknowledged: 'Acknowledged',
    crew_assigned: 'Crew Assigned',
    resolved: 'Resolved',
    verified: 'Verified',
    closed: 'Closed',
  };

  return labels[status] ?? formatEventType(status ?? 'updated');
}

function getTimelineStatusOrder(status) {
  const order = {
    detected: 0,
    acknowledged: 3,
    crew_assigned: 4,
    resolved: 5,
    verified: 6,
    closed: 7,
  };

  return order[status] ?? 99;
}

function useActiveHashSection() {
  const [activeSection, setActiveSection] = useState(getActiveHashSection);

  useEffect(() => {
    function syncActiveSection() {
      setActiveSection(getActiveHashSection());
    }

    window.addEventListener('hashchange', syncActiveSection);

    return () => window.removeEventListener('hashchange', syncActiveSection);
  }, []);

  return activeSection;
}

function getActiveHashSection() {
  const hash = window.location.hash.replace('#', '');

  return CONSOLE_SECTIONS.includes(hash) ? hash : 'dashboard';
}

function buildNetworkStats(network) {
  const poles = network?.poles ?? [];
  const devicePoles = poles.filter((pole) => pole.current?.deviceId);
  const liveDevices = devicePoles.filter(
    (pole) => pole.current?.lastState === 'live',
  ).length;
  const lastTelemetryAt = devicePoles
    .map((pole) => pole.current?.lastSeenTs)
    .filter(Boolean)
    .sort((left, right) => new Date(right) - new Date(left))[0];

  return {
    totalPoles: poles.length,
    totalDevices: devicePoles.length,
    liveDevices,
    darkDevices: devicePoles.filter(
      (pole) => pole.current?.lastState === 'dark',
    ).length,
    noSensorPoles: poles.length - devicePoles.length,
    lastTelemetryAt,
  };
}

function buildFeederSummaries(network, incidents) {
  const poles = network?.poles ?? [];
  const activeIncidentsByFeeder = new Map();

  for (const incident of incidents ?? []) {
    if (!incident.feederId) {
      continue;
    }

    activeIncidentsByFeeder.set(
      incident.feederId,
      (activeIncidentsByFeeder.get(incident.feederId) ?? 0) + 1,
    );
  }

  return (network?.feeders ?? [])
    .map((feeder) => {
      const feederPoles = poles.filter(
        (pole) => pole.feederId === feeder.feederId,
      );
      const feederDevices = feederPoles.filter(
        (pole) => pole.current?.deviceId,
      );

      return {
        feederId: feeder.feederId,
        poleCount: feederPoles.length,
        deviceCount: feederDevices.length,
        liveDevices: feederDevices.filter(
          (pole) => getPoleState(pole) === 'live',
        ).length,
        activeIncidents: activeIncidentsByFeeder.get(feeder.feederId) ?? 0,
      };
    })
    .sort((left, right) => compareIds(left.feederId, right.feederId));
}

function getPolesForDt(network, dtId) {
  return (network?.poles ?? [])
    .filter((pole) => pole.dtId === dtId)
    .sort((left, right) => compareIds(left.poleId, right.poleId));
}

function getPoleState(pole) {
  if (!pole.current?.deviceId && !pole.deviceId) {
    return 'no-sensor';
  }

  const lastState = pole.current?.lastState ?? pole.lastState;

  return lastState === 'dark' ? 'dark' : lastState === 'live' ? 'live' : 'idle';
}

function getDeviceColor(state) {
  if (state === 'live') {
    return '#33D17A';
  }

  if (state === 'dark') {
    return '#FF4D6D';
  }

  return '#6B7280';
}

function getStatusColor(status) {
  const colors = {
    detected: '#FF4D6D',
    acknowledged: '#FFB84D',
    crew_assigned: '#FFD666',
    resolved: '#7BD88F',
    verified: '#33D17A',
    closed: '#6B7280',
  };

  return colors[status] ?? '#5EA2FF';
}

function summarizeSimulatorResult(result) {
  if (!result) {
    return 'Simulator request completed.';
  }

  const telemetryCount = result.telemetry?.generatedEventCount ?? 0;
  const affectedCount = result.affectedPoleCount ?? 0;
  const detectionCount = result.detection?.createdIncidentCount ?? 0;

  return `${telemetryCount} telemetry events sent across ${affectedCount} affected poles. ${detectionCount} new incident candidates created.`;
}

function formatIncidentType(type) {
  return INCIDENT_TYPE_LABELS[type] ?? capitalize(type);
}

function formatEventType(type) {
  return type
    .split('_')
    .map((part) => capitalize(part))
    .join(' ');
}

function formatPoleState(state) {
  return state.replace('-', ' ');
}

function formatCoordinates(lat, lon) {
  if (!lat || !lon) {
    return '—';
  }

  return `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
}

function formatRelativeTime(value) {
  if (!value) {
    return 'No telemetry';
  }

  const date = value instanceof Date ? value : new Date(value);
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (absMs < minute) {
    return 'just now';
  }

  if (absMs < hour) {
    return `${Math.round(absMs / minute)}m ago`;
  }

  if (absMs < day) {
    return `${Math.round(absMs / hour)}h ago`;
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function toPercent(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return '—';
  }

  return `${Math.round(numeric * 100)}%`;
}

function capitalize(value) {
  if (!value) {
    return '—';
  }

  return `${value}`.charAt(0).toUpperCase() + `${value}`.slice(1);
}

function compareIds(left, right) {
  return left.localeCompare(right);
}
