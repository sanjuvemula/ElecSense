import { eq, sql } from 'drizzle-orm';

import { db as defaultDb } from '../db/index.js';
import { dts, poles } from '../db/schema.js';

const DT_ROOT_ID = '__dt__';
const DEFAULT_NEIGHBOR_COUNT = 8;
const INSERT_CHUNK_SIZE = 500;
const topologyCache = new Map();

export async function inferTopology(dtId, options = {}) {
  const database = options.db ?? defaultDb;

  if (!database) {
    const error = new Error('DATABASE_URL is not configured.');
    error.status = 503;
    throw error;
  }

  const { dt, poles: poleRows } = await fetchDtTopologyInputs(database, dtId);
  const cacheKey = buildCacheKey(poleRows);
  const cached = topologyCache.get(dtId);

  if (cached?.cacheKey === cacheKey) {
    return cached.tree;
  }

  const tree = buildTopologyForDt({
    dt,
    poles: poleRows,
    neighborCount: options.neighborCount ?? DEFAULT_NEIGHBOR_COUNT,
  });

  if (tree.topologySource === 'inferred' && options.persist !== false) {
    await persistInferredTopology(database, tree);
  }

  topologyCache.set(dtId, { cacheKey, tree });

  return tree;
}

export async function getTopologySourceForDt(dtId, options = {}) {
  const database = options.db ?? defaultDb;

  if (!database) {
    const error = new Error('DATABASE_URL is not configured.');
    error.status = 503;
    throw error;
  }

  const rows = await database
    .select({
      poleId: poles.poleId,
      seqOnLine: poles.seqOnLine,
      parentPoleId: poles.parentPoleId,
    })
    .from(poles)
    .where(eq(poles.dtId, dtId));

  return getTopologySourceForPoles(rows);
}

export function buildTopologyForDt({
  dt,
  poles: poleRows,
  neighborCount = DEFAULT_NEIGHBOR_COUNT,
}) {
  const topologySource = getTopologySourceForPoles(poleRows);

  if (topologySource === 'surveyed') {
    return buildSurveyedTopology(dt, poleRows);
  }

  return buildInferredTopology(dt, poleRows, neighborCount);
}

export function getTopologySourceForPoles(poleRows) {
  if (
    poleRows.length > 0 &&
    poleRows.every(
      (pole) => pole.seqOnLine !== null && pole.seqOnLine !== undefined,
    )
  ) {
    return 'surveyed';
  }

  return 'inferred';
}

export function clearTopologyCache() {
  topologyCache.clear();
}

export function haversineMeters(first, second) {
  const earthRadiusMeters = 6_371_000;
  const firstLat = toRadians(Number(first.lat));
  const secondLat = toRadians(Number(second.lat));
  const deltaLat = secondLat - firstLat;
  const deltaLon = toRadians(Number(second.lon) - Number(first.lon));
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const a =
    sinLat * sinLat +
    Math.cos(firstLat) * Math.cos(secondLat) * sinLon * sinLon;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchDtTopologyInputs(database, dtId) {
  const [dt] = await database
    .select({
      dtId: dts.dtId,
      lat: dts.lat,
      lon: dts.lon,
    })
    .from(dts)
    .where(eq(dts.dtId, dtId))
    .limit(1);

  if (!dt) {
    const error = new Error(`DT not found: ${dtId}`);
    error.status = 404;
    throw error;
  }

  const poleRows = await database
    .select({
      poleId: poles.poleId,
      lat: poles.lat,
      lon: poles.lon,
      dtId: poles.dtId,
      seqOnLine: poles.seqOnLine,
      parentPoleId: poles.parentPoleId,
      inferredParentId: poles.inferredParentId,
      inferredSeq: poles.inferredSeq,
      topologyConfidence: poles.topologyConfidence,
    })
    .from(poles)
    .where(eq(poles.dtId, dtId));

  return { dt, poles: poleRows };
}

function buildSurveyedTopology(dt, poleRows) {
  const assignments = new Map(
    poleRows.map((pole) => [
      pole.poleId,
      {
        parentPoleId: pole.parentPoleId,
        seq: pole.seqOnLine,
        topologyConfidence: parseNullableNumber(pole.topologyConfidence) ?? 1,
        suspicious: false,
      },
    ]),
  );

  return buildTreeResult({
    dt,
    poles: poleRows,
    topologySource: 'surveyed',
    assignments,
    neighborCountUsed: null,
  });
}

function buildInferredTopology(dt, poleRows, neighborCount) {
  const graphNodes = [
    { id: DT_ROOT_ID, type: 'dt', lat: Number(dt.lat), lon: Number(dt.lon) },
    ...poleRows.map((pole) => ({
      id: pole.poleId,
      type: 'pole',
      lat: Number(pole.lat),
      lon: Number(pole.lon),
      pole,
    })),
  ];

  const { adjacency, neighborCountUsed } = buildMstAdjacency(
    graphNodes,
    neighborCount,
  );
  const rootedNodes = rootMst(adjacency);
  const nearestDistances = computeNearestDistances(graphNodes);
  const assignments = new Map();

  for (const node of graphNodes) {
    if (node.type !== 'pole') {
      continue;
    }

    const rooted = rootedNodes.get(node.id);
    const parentPoleId =
      rooted.parentId === DT_ROOT_ID || !rooted.parentId
        ? null
        : rooted.parentId;
    const nearestDistance = nearestDistances.get(node.id);
    const confidence = computeTopologyConfidence(
      rooted.edgeDistanceMeters,
      nearestDistance,
    );

    assignments.set(node.id, {
      parentPoleId,
      seq: rooted.depth,
      edgeDistanceMeters: rooted.edgeDistanceMeters,
      nearestNeighborMeters: nearestDistance,
      topologyConfidence: confidence,
      suspicious: confidence < 0.6,
    });
  }

  return buildTreeResult({
    dt,
    poles: poleRows,
    topologySource: 'inferred',
    assignments,
    neighborCountUsed,
  });
}

function buildTreeResult({
  dt,
  poles: poleRows,
  topologySource,
  assignments,
  neighborCountUsed,
}) {
  const root = {
    id: dt.dtId,
    type: 'dt',
    lat: Number(dt.lat),
    lon: Number(dt.lon),
    children: [],
  };
  const poleById = new Map(poleRows.map((pole) => [pole.poleId, pole]));
  const nodes = {};
  const edges = [];

  for (const pole of poleRows) {
    const assignment = assignments.get(pole.poleId);
    const parentPoleId = poleById.has(assignment.parentPoleId)
      ? assignment.parentPoleId
      : null;
    const parentNode = parentPoleId ? poleById.get(parentPoleId) : root;
    const edgeDistanceMeters =
      assignment.edgeDistanceMeters ??
      haversineMeters(
        { lat: pole.lat, lon: pole.lon },
        { lat: parentNode.lat, lon: parentNode.lon },
      );

    nodes[pole.poleId] = {
      poleId: pole.poleId,
      parentPoleId,
      children: [],
      seq: assignment.seq,
      depth: null,
      lat: Number(pole.lat),
      lon: Number(pole.lon),
      edgeDistanceMeters: round(edgeDistanceMeters, 2),
      nearestNeighborMeters:
        assignment.nearestNeighborMeters === undefined
          ? null
          : round(assignment.nearestNeighborMeters, 2),
      topologyConfidence: round(assignment.topologyConfidence, 4),
      suspicious: assignment.suspicious,
    };
  }

  for (const node of Object.values(nodes)) {
    if (node.parentPoleId && nodes[node.parentPoleId]) {
      nodes[node.parentPoleId].children.push(node.poleId);
    } else {
      root.children.push(node.poleId);
    }
  }

  assignDepths(nodes, root.children);

  for (const node of Object.values(nodes)) {
    node.children.sort(compareIds);
    edges.push({
      parentPoleId: node.parentPoleId,
      poleId: node.poleId,
      distanceMeters: node.edgeDistanceMeters,
      topologyConfidence: node.topologyConfidence,
      suspicious: node.suspicious,
    });
  }

  root.children.sort(compareIds);
  edges.sort((left, right) => compareIds(left.poleId, right.poleId));

  return {
    dtId: dt.dtId,
    topologySource,
    neighborCountUsed,
    root,
    nodes,
    edges,
  };
}

function buildMstAdjacency(nodes, requestedNeighborCount) {
  const maxNeighborCount = nodes.length - 1;

  if (maxNeighborCount === 0) {
    return {
      adjacency: new Map([[DT_ROOT_ID, []]]),
      neighborCountUsed: 0,
    };
  }

  for (
    let neighborCount = Math.min(
      Math.max(1, requestedNeighborCount),
      maxNeighborCount,
    );
    neighborCount <= maxNeighborCount;
    neighborCount = Math.min(maxNeighborCount, neighborCount * 2)
  ) {
    const edges = buildKNearestEdges(nodes, neighborCount);
    const mstEdges = kruskal(nodes, edges);

    if (mstEdges.length === nodes.length - 1) {
      return {
        adjacency: buildAdjacency(mstEdges),
        neighborCountUsed: neighborCount,
      };
    }

    if (neighborCount === maxNeighborCount) {
      break;
    }
  }

  throw new Error('Unable to infer connected topology graph for DT.');
}

function buildKNearestEdges(nodes, neighborCount) {
  const edgesByKey = new Map();

  for (const node of nodes) {
    const nearest = nodes
      .filter((candidate) => candidate.id !== node.id)
      .map((candidate) => ({
        from: node.id,
        to: candidate.id,
        distanceMeters: haversineMeters(node, candidate),
      }))
      .sort(compareEdges)
      .slice(0, neighborCount);

    for (const edge of nearest) {
      const key = edgeKey(edge.from, edge.to);

      if (!edgesByKey.has(key)) {
        edgesByKey.set(key, edge);
      }
    }
  }

  return Array.from(edgesByKey.values()).sort(compareEdges);
}

function kruskal(nodes, edges) {
  const unionFind = new UnionFind(nodes.map((node) => node.id));
  const selected = [];

  for (const edge of edges) {
    if (unionFind.union(edge.from, edge.to)) {
      selected.push(edge);
    }

    if (selected.length === nodes.length - 1) {
      break;
    }
  }

  return selected;
}

function buildAdjacency(edges) {
  const adjacency = new Map([[DT_ROOT_ID, []]]);

  for (const edge of edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }

    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, []);
    }

    adjacency.get(edge.from).push({
      nodeId: edge.to,
      distanceMeters: edge.distanceMeters,
    });
    adjacency.get(edge.to).push({
      nodeId: edge.from,
      distanceMeters: edge.distanceMeters,
    });
  }

  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) =>
      left.distanceMeters === right.distanceMeters
        ? compareIds(left.nodeId, right.nodeId)
        : left.distanceMeters - right.distanceMeters,
    );
  }

  return adjacency;
}

function rootMst(adjacency) {
  const rooted = new Map([
    [
      DT_ROOT_ID,
      {
        parentId: null,
        depth: 0,
        edgeDistanceMeters: 0,
      },
    ],
  ]);
  const queue = [DT_ROOT_ID];

  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    const parent = rooted.get(nodeId);

    for (const neighbor of adjacency.get(nodeId) ?? []) {
      if (rooted.has(neighbor.nodeId)) {
        continue;
      }

      rooted.set(neighbor.nodeId, {
        parentId: nodeId,
        depth: parent.depth + 1,
        edgeDistanceMeters: neighbor.distanceMeters,
      });
      queue.push(neighbor.nodeId);
    }
  }

  return rooted;
}

function computeNearestDistances(nodes) {
  const nearestDistances = new Map();

  for (const node of nodes) {
    if (node.type !== 'pole') {
      continue;
    }

    let nearest = Number.POSITIVE_INFINITY;

    for (const candidate of nodes) {
      if (candidate.id === node.id) {
        continue;
      }

      nearest = Math.min(nearest, haversineMeters(node, candidate));
    }

    nearestDistances.set(node.id, nearest);
  }

  return nearestDistances;
}

function computeTopologyConfidence(edgeDistanceMeters, nearestNeighborMeters) {
  if (!Number.isFinite(edgeDistanceMeters) || edgeDistanceMeters <= 0) {
    return 1;
  }

  if (!Number.isFinite(nearestNeighborMeters) || nearestNeighborMeters <= 0) {
    return 1;
  }

  return clamp(nearestNeighborMeters / edgeDistanceMeters, 0, 1);
}

async function persistInferredTopology(database, tree) {
  const updates = Object.values(tree.nodes).map((node) => ({
    poleId: node.poleId,
    inferredParentId: node.parentPoleId,
    inferredSeq: node.seq,
    topologyConfidence: node.topologyConfidence.toFixed(4),
  }));

  for (const chunk of chunks(updates, INSERT_CHUNK_SIZE)) {
    const values = sql.join(
      chunk.map(
        (update) =>
          sql`(${update.poleId}, ${update.inferredParentId}::text, ${update.inferredSeq}::integer, ${update.topologyConfidence}::numeric)`,
      ),
      sql`, `,
    );

    await database.execute(sql`
      update ${poles}
      set
        inferred_parent_id = incoming.inferred_parent_id,
        inferred_seq = incoming.inferred_seq,
        topology_confidence = incoming.topology_confidence
      from (
        values ${values}
      ) as incoming(
        pole_id,
        inferred_parent_id,
        inferred_seq,
        topology_confidence
      )
      where ${poles.poleId} = incoming.pole_id
    `);
  }
}

function assignDepths(nodes, rootChildren) {
  const queue = rootChildren.map((poleId) => ({ poleId, depth: 1 }));

  for (let index = 0; index < queue.length; index += 1) {
    const { poleId, depth } = queue[index];
    const node = nodes[poleId];

    if (!node) {
      continue;
    }

    node.depth = depth;

    for (const childPoleId of node.children) {
      queue.push({ poleId: childPoleId, depth: depth + 1 });
    }
  }
}

function buildCacheKey(poleRows) {
  return poleRows
    .map((pole) => pole.poleId)
    .sort(compareIds)
    .join('|');
}

function edgeKey(first, second) {
  return [first, second].sort(compareIds).join('::');
}

function compareEdges(left, right) {
  if (left.distanceMeters !== right.distanceMeters) {
    return left.distanceMeters - right.distanceMeters;
  }

  const leftKey = edgeKey(left.from, left.to);
  const rightKey = edgeKey(right.from, right.to);

  return compareIds(leftKey, rightKey);
}

function compareIds(left, right) {
  return left.localeCompare(right);
}

function parseNullableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function round(value, decimals) {
  const scale = 10 ** decimals;

  return Math.round(value * scale) / scale;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function chunks(values, size) {
  const result = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

class UnionFind {
  constructor(ids) {
    this.parents = new Map(ids.map((id) => [id, id]));
    this.ranks = new Map(ids.map((id) => [id, 0]));
  }

  find(id) {
    const parent = this.parents.get(id);

    if (parent !== id) {
      this.parents.set(id, this.find(parent));
    }

    return this.parents.get(id);
  }

  union(first, second) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);

    if (firstRoot === secondRoot) {
      return false;
    }

    const firstRank = this.ranks.get(firstRoot);
    const secondRank = this.ranks.get(secondRoot);

    if (firstRank < secondRank) {
      this.parents.set(firstRoot, secondRoot);
    } else if (firstRank > secondRank) {
      this.parents.set(secondRoot, firstRoot);
    } else {
      this.parents.set(secondRoot, firstRoot);
      this.ranks.set(firstRoot, firstRank + 1);
    }

    return true;
  }
}
