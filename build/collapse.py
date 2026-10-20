"""Degree-2 chain collapse (build pipeline step 2).

Merges chains of pass-through nodes into single edges, so a straight road split
into 50 OSM segments becomes one edge. Pure and fully unit-tested.

Collapse runs on the **raw** network, *before* elevation is measured. That order
is load-bearing: OSM splits roads into node-to-node segments with a median length
of ~10 m, far shorter than the 200 m ``max_slope`` window. Measuring each segment
first and taking the max over the chain afterwards meant every road's max slope
was its single noisiest 10 m step -- the 200 m smoothing never applied. Measuring
the merged edge integrates ascent over the whole profile and slides the slope
window across what used to be segment joints, as the spec intends.

A degree-2 node is collapsed only when its two edges:

* go to two *distinct* neighbours (a parallel pair or a self-loop is left alone),
* share the same ``surface``, ``highway`` and ``structure`` (so the merged edge
  has one honest surface for the road/gravel toggle, class boundaries are
  preserved, and a bridge or tunnel stays its own edge for ``dem.py`` to give a
  straight profile), and
* leave the merged edge traversable in at least one direction (a one-way chain
  collapses into one one-way edge; a genuine barrier is not collapsed).

Everything else -- junctions, surface/class/structure boundaries, one-way/two-way
seams -- stays, which is exactly where the graph should keep its nodes.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from typing import Final

from build.osm_load import RawEdge, RawNetwork


@dataclass(frozen=True)
class _Oriented:
    """One edge as walked from a given node toward the other."""

    to_node: int
    forward: bool            # traversable in the walk direction
    backward: bool           # traversable against it
    geometry: list[tuple[float, float]]  # oriented from the given node onward


def _orient(edge: RawEdge, from_node: int) -> _Oriented:
    """Reorient an edge to a walk starting at ``from_node``.

    Walking against the stored ``u -> v`` orientation swaps the two directions and
    reverses the geometry, so the merged polyline stays continuous.
    """
    if from_node == edge.u:
        return _Oriented(
            to_node=edge.v, forward=edge.forward, backward=edge.backward,
            geometry=edge.geometry,
        )
    if from_node == edge.v:
        return _Oriented(
            to_node=edge.u, forward=edge.backward, backward=edge.forward,
            geometry=list(reversed(edge.geometry)),
        )
    raise ValueError(f"node {from_node} is not an endpoint of edge {edge.u}->{edge.v}")


def _through_directions(e1: RawEdge, e2: RawEdge, node: int) -> tuple[bool, bool]:
    """Traversability of the merged chain ``A - node - B`` in both directions."""
    o1 = _orient(e1, node)  # node -> A
    o2 = _orient(e2, node)  # node -> B
    # Forward A->B: enter node from A (against o1) then leave to B (with o2).
    forward = o1.backward and o2.forward
    # Backward B->A: enter node from B (against o2) then leave to A (with o1).
    backward = o2.backward and o1.forward
    return forward, backward


def _adjacency(net: RawNetwork) -> dict[int, list[int]]:
    adj: dict[int, list[int]] = defaultdict(list)
    for i, e in enumerate(net.edges):
        adj[e.u].append(i)
        adj[e.v].append(i)
    return adj


def _is_removable(net: RawNetwork, node: int, adj: dict[int, list[int]]) -> bool:
    """Whether a node is an interior point of a collapsible chain."""
    idxs = adj[node]
    if len(idxs) != 2:
        return False
    e1, e2 = net.edges[idxs[0]], net.edges[idxs[1]]
    neighbours = {e1.u, e1.v, e2.u, e2.v} - {node}
    if len(neighbours) != 2:
        return False  # parallel edges or a self-loop -- collapsing would loop
    if e1.surface != e2.surface or e1.highway != e2.highway:
        return False  # preserve surface/class boundaries
    if e1.structure != e2.structure:
        return False  # a bridge/tunnel keeps its own straight-profile edge
    forward, backward = _through_directions(e1, e2, node)
    return forward or backward  # a genuine barrier stays


def collapse_degree2(net: RawNetwork) -> RawNetwork:
    """Return a new network with collapsible degree-2 chains merged.

    Nodes that vanish are the chain interiors; every junction and boundary node is
    kept. Node coordinates for kept nodes are carried over unchanged.
    """
    adj = _adjacency(net)
    removable = {n for n in adj if _is_removable(net, n, adj)}

    visited: list[bool] = [False] * len(net.edges)
    merged_edges: list[RawEdge] = []

    # Anchor chains at every non-removable node and walk outward.
    anchors = [n for n in adj if n not in removable]
    for anchor in anchors:
        for start in adj[anchor]:
            if visited[start]:
                continue
            merged = _walk_chain(net, anchor, start, removable, adj, visited)
            if merged is not None:
                merged_edges.append(merged)

    # Any edge still unvisited belongs to a ring made entirely of removable nodes
    # (no anchor to start from). Break each such ring by treating one of its nodes
    # as an anchor, so the ring collapses to a single self-adjacent chain.
    for i, e in enumerate(net.edges):
        if visited[i]:
            continue
        ring_anchor = e.u
        merged = _walk_chain(net, ring_anchor, i, removable - {ring_anchor}, adj, visited)
        if merged is not None:
            merged_edges.append(merged)

    kept_nodes = {n for e in merged_edges for n in (e.u, e.v)}
    return RawNetwork(
        node_lat={n: net.node_lat[n] for n in kept_nodes},
        node_lon={n: net.node_lon[n] for n in kept_nodes},
        edges=merged_edges,
    )


def _walk_chain(
    net: RawNetwork,
    anchor: int,
    start_edge: int,
    removable: set[int],
    adj: dict[int, list[int]],
    visited: list[bool],
) -> RawEdge | None:
    """Walk from ``anchor`` along ``start_edge`` through removable nodes, merging.

    Returns the merged edge from ``anchor`` to the far anchor, or ``None`` if the
    starting edge was already consumed.
    """
    if visited[start_edge]:
        return None

    first = net.edges[start_edge]
    template = first  # for surface/highway/structure/way_id provenance
    step = _orient(first, anchor)
    visited[start_edge] = True

    forward = step.forward
    backward = step.backward
    geometry = list(step.geometry)

    current = step.to_node
    prev_edge = start_edge

    # Extend while the current node is a removable chain interior.
    while current in removable:
        nxt = [i for i in adj[current] if i != prev_edge]
        if len(nxt) != 1:
            break  # defensive: removable guarantees exactly one other edge
        edge_idx = nxt[0]
        if visited[edge_idx]:
            break  # closed a ring back onto a consumed edge
        step = _orient(net.edges[edge_idx], current)
        visited[edge_idx] = True

        forward = forward and step.forward
        backward = backward and step.backward
        geometry.extend(step.geometry[1:])  # drop the shared junction point

        prev_edge = edge_idx
        current = step.to_node

    return replace(
        template, u=anchor, v=current, forward=forward, backward=backward, geometry=geometry,
    )


#: Default: drop weakly-connected components smaller than this. Small enough to
#: keep any real neighbourhood, large enough to remove the disconnected stubs a
#: bbox clip (test regions) or mapping errors leave behind. The largest component
#: is always kept, whatever the threshold.
DEFAULT_MIN_COMPONENT_NODES: Final = 25


def prune_small_components(
    net: RawNetwork, min_component_nodes: int = DEFAULT_MIN_COMPONENT_NODES
) -> RawNetwork:
    """Drop nodes/edges in weakly-connected components below a size threshold.

    Standard routing-graph cleanup: a bikeable network is essentially one giant
    connected component, and the rest are clipped fragments, private stubs or
    mapping gaps a rider can never reach. Keeping them only produces tiny,
    broken-looking effort fields when a click snaps onto one. The largest
    component is always kept even if the threshold is set higher than its peers.
    Runs before elevation is measured, so the dropped fragments are never sampled.

    Weakly-connected (undirected) is the right lens here: it is what a rider can
    reach ignoring one-way direction, which is what the effort field colours.
    """
    if net.edge_count == 0:
        return net

    parent: dict[int, int] = {}

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:  # path compression
            parent[x], x = root, parent[x]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for e in net.edges:
        parent.setdefault(e.u, e.u)
        parent.setdefault(e.v, e.v)
        union(e.u, e.v)

    sizes = Counter(find(n) for n in parent)
    largest_root = max(sizes, key=lambda r: sizes[r])
    kept_roots = {r for r, s in sizes.items() if s >= min_component_nodes}
    kept_roots.add(largest_root)

    kept_edges = [e for e in net.edges if find(e.u) in kept_roots]
    kept_nodes = {n for e in kept_edges for n in (e.u, e.v)}

    return RawNetwork(
        node_lat={n: net.node_lat[n] for n in kept_nodes},
        node_lon={n: net.node_lon[n] for n in kept_nodes},
        edges=kept_edges,
    )


#: Exposed for tests: how many geometric edges a network has.
def edge_count(net: RawNetwork) -> int:
    return len(net.edges)


_ALL: Final = ("collapse_degree2", "prune_small_components", "edge_count")
