# VeloRouter – Spec v1 (Schweiz)

Elevation-aware Bike-Routing mit Effort-Coloring: Klick auf Startpunkt → Karte zeigt, wohin man mit welchem Aufwand kommt. Einstellbare Höhenmeter-Präferenz (α) und Steigungsfilter.

## Architektur

Drei Schichten, getrennt nach Änderungsfrequenz:

**Statisch (quartalsweiser Rebuild, CDN-cached):** Netz-Geometrie als PMTiles auf R2. MapLibre lädt nur Viewport-Tiles (KB-Bereich), Level-of-Detail via tippecanoe gratis. Der Worker kennt keine Geometrie.

**Dynamisch (pro Startpunkt / α-Änderung, klein):** Effort-Response als Float32-Binary `(edge_id → cost)`, wenige hundert KB schweizweit. Frontend joint per `setFeatureState` an die Tiles.

**Worker (Compute):** Lädt `graph.bin` (reine Topologie, CSR-Format) aus R2, hält es im Memory-Cache. Dijkstra/A* mit Cost-Modell `w = dist + climb_factor·ascent`, Slope-Hard-Filter als Query-Parameter.

Binary-Header enthält von Tag 1: Format-Version, Region-ID, Bounding Box → Europa-Sharding später ohne Format-Bruch.

### Datenfluss

```
OSM PBF (Geofabrik CH) ─┐
                        ├─ Build-Pipeline (Python, Laptop) ─→ graph.bin (~40–60 MB) ─→ R2 ─→ Worker
swissALTI3D 2m Tiles  ──┘                                  └→ network.pmtiles (~15–25 MB) ─→ R2 ─→ MapLibre
                                                            └→ meta.json
Frontend (React/Vite, CF Pages) ←→ Worker-API
```

## Repo-Struktur (Monorepo – alles in einer Codebase)

Claude Code erstellt alle drei Teile im selben Repo:

```
velorouter/
├── build/          # Python-Pipeline (Graph berechnen) – wird LOKAL ausgeführt, nicht deployed
│   ├── build_graph.py      # Orchestrierung: ein Aufruf, alle Schritte
│   ├── osm_load.py         # PBF → Bike-Netz-Graph
│   ├── dem.py              # swissALTI3D-Tiles holen + Sampling
│   ├── collapse.py         # Degree-2-Kollaps + Attribut-Aggregation
│   ├── export.py           # graph.bin + GeoJSON + meta.json schreiben
│   ├── binformat.py        # Binary-Format-Definition (Single Source of Truth, s.u.)
│   └── requirements.txt
├── worker/         # TypeScript, Cloudflare Worker (deployed)
│   ├── src/ (binformat.ts spiegelt binformat.py, router.ts, index.ts)
│   └── wrangler.toml       # inkl. limits.cpu_ms, R2-Binding
├── frontend/       # React/Vite + MapLibre (CF Pages, deployed)
└── testdata/       # Ridge-World-Generator + Referenz-Outputs für Python↔TS-Verifikation
```

Wichtig für die Format-Konsistenz: `binformat.py` und `binformat.ts` implementieren dasselbe Format; `testdata/` enthält ein von Python generiertes Ridge-World-`graph.bin` plus erwartete Routing-Resultate als JSON – der TS-Router muss diese in Tests exakt reproduzieren (Ground-Truth-Vergleich). Das ist der Verifikations-Mechanismus zwischen den beiden Sprachen.

## Build-Pipeline (`build/`, Python – Skript in der Codebase, Ausführung lokal)

Teil des Repos, aber nicht deployed: `python build/build_graph.py --region switzerland` läuft auf dem lokalen PC (Anforderungen s. Infrastruktur) und produziert die Artefakte für R2. Schritte:

1. **OSM laden:** Geofabrik `switzerland-latest.osm.pbf` (~400 MB), Bike-Netz filtern (pyrosm oder osmnx), MultiDiGraph bauen.
2. **DEM:** swissALTI3D 2 m, tile-weiser Download nur für Strassenkorridore (swisstopo STAC-API). Fallback: Copernicus GLO-30.
3. **Sampling:** Jede Edge-Polyline alle 10 m gegen DEM. Pro gerichtete Edge: `dist`, `ascent` (Σ positive Δh, ungeglättet), `descent`, `max_slope` (200-m-Rolling-Window, geglättet).
4. **Kollaps:** Degree-2-Ketten mergen; ascent/descent summieren, max_slope maxen, Geometrie konkatenieren.
5. **Export:**
   - `graph.bin` – CSR: Nodes (lat, lon, elev als f32) + gerichtete Edges (target u32, dist f32, ascent f32, descent f32, max_slope u8 in 0.25%-Schritten). Header: magic, version, region_id, bbox. Plus Grid-Spatial-Index fürs Snapping.
   - Edges-GeoJSON (Douglas-Peucker 20 m, edge_id als Property) → tippecanoe → `network.pmtiles`.
   - `meta.json` (bbox, build_date, format_version).
6. **Upload** nach R2 (`wrangler r2 object put`, als `--upload`-Flag im Skript integriert).

Laufzeit: Nacht auf dem lokalen PC; DEM-Download ist der langsamste Teil. Das Skript soll resumable sein (heruntergeladene DEM-Tiles und Zwischenresultate cachen, z.B. in `build/cache/` – bei Abbruch nicht von vorn beginnen) und einen `--region`-Parameter mit kleiner Test-Region (z.B. ein Bezirk) anbieten, um die Pipeline in Minuten statt Stunden testen zu können, bevor der Schweiz-Lauf startet.

## Worker-API (TypeScript, Cloudflare)

- `POST /effort-field` – `{lat, lon, alpha, max_slope?}` → Dijkstra-Baum vom gesnappten Start; Response: Binary `(edge_id u32, cost f32)` für alle Edges unterm Max-Budget.
- `POST /route` – `{from, to, alpha, max_slope?}` → A* (admissible Heuristik: Luftlinie + climb_factor·max(0, Δh_netto)); Response: edge_id-Sequenz + Summen (dist, ascent, descent, max_slope).
- `GET /snap` – Koordinate → nächster Graph-Node (Grid-Index).

Slope-Filter = Edges mit `max_slope > limit` beim Expandieren überspringen (Heuristik bleibt gültig).

## Frontend-Features v1 (React/Vite + MapLibre, CF Pages)

- Klick setzt Start → Effort-Coloring: Edges als dicke Linien (200 m reale Strichbreite, `line-cap: round`, zoomabhängig, min ~2 px) → wirkt wie 100-m-Buffer; verschmilzt im Mittelland zu Flächen, bleibt in Tälern ehrlich korridorförmig.
- Farbskala = Zeit-Bänder (Flach-Äquivalent ÷ einstellbare Flachgeschwindigkeit, Default 27 km/h); Toggle auf Flach-km. 4–6 Stufen, farbenblind-tauglich.
- Slider α (0 = kürzeste, 1 = flachste) und max. Steigung → neuer Worker-Call. Budget-/Farbslider → rein clientseitig (Style-Änderung, null Netzwerk).
- Zweiter Klick → Route als Linie + Stats-Panel (km, Hm auf/ab, max %).
- Bewusst nicht in v1: Suche/Geocoding, Turn-by-Turn, Via-Punkte, GPX (nachrüstbar), Accounts, Offline.

## Infrastruktur / was du bereitstellen musst

**Cloudflare (Account hast du – gleicher Stack wie KOM QOM):**

| Dienst | Zweck | Anforderung | Kosten |
|---|---|---|---|
| Workers **Paid** | Routing-API | 128 MB Memory (graph.bin ~60 MB passt); CPU-Zeit: schweizweiter Dijkstra einige 100 ms → **Free-Tier (10 ms CPU) reicht nicht**, Paid erlaubt bis 5 min | $5/Mt. |
| R2 | graph.bin, network.pmtiles, meta.json | < 200 MB Storage, Range-Requests (PMTiles) | Free-Tier (10 GB) reicht, $0 |
| Pages | Frontend-Hosting | – | Free |

**Build-Maschine (dein Laptop, einmalig pro Rebuild):**

- Python 3.11+, ~16 GB RAM (Graph + Raster-Fenster; 8 GB geht mit tile-weisem Processing, aber zäher)
- **~60 GB freier Disk**: DEM-Tiles ~40 GB + OSM-PBF + Intermediates (nach Build löschbar bis auf Outputs)
- Tools: `pip: osmnx/pyrosm, rasterio, numpy, shapely, pyproj` + `tippecanoe` (brew/apt) + `wrangler`
- Stabile Verbindung für den DEM-Download (grösster Zeitfaktor)

**Kein weiterer Server nötig.** Hetzner o.ä. erst relevant, falls Europa-Scope oder CPU-Limits im Worker real zum Problem werden – Architektur lässt beides offen (Shards / Python-Core läuft unverändert auf einem VPS).

## Reihenfolge der Umsetzung (alles von Claude Code im Monorepo erstellt)

1. **`binformat.py` + `binformat.ts` + `testdata/`** – Format definieren, Ridge-World-Testgraph generieren, TS-Router (Dijkstra/A*) gegen Python-Ground-Truth verifizieren.
2. **`worker/`** – Endpoints effort-field, route, snap; lokal mit Ridge-World-Binary via `wrangler dev` testen.
3. **`build/`** – komplette Pipeline; erst mit `--region <klein>` verifizieren, dann Schweiz-Lauf über Nacht auf dem lokalen PC, Upload nach R2.
4. **`frontend/`** – MapLibre-Umbau des Dezember-Prototyps, PMTiles-Layer, Effort-Coloring via setFeatureState, Sliders.
5. Danach: GPX-Export, Graph H (POI-Layer), Europa-Shards.

Einziger manueller Schritt für Pascal: Schritt 3 lokal ausführen (eine Nacht) und Cloudflare-Ressourcen bereitstellen (Workers Paid, R2-Bucket) – alles andere entsteht und läuft direkt aus der Codebase.

## Offene Punkte

- Einbahnstrassen: v1 ignoriert sie (undirected) oder respektiert sie (directed, Binary kann's) – Entscheid vor Schritt 3.
- Zeitmodell: v1 linear (÷ Flachgeschwindigkeit); später Physikmodell aus KOM QOM (P(v) invertieren).
- OSM-Filter-Details: welche highway-Typen rein (track/path mit surface-Tags?) – Entscheid vor Schritt 3, betrifft Rennrad- vs. Gravel-Profil.