# VeloRouter – Spec v1 (Schweiz)

Elevation-aware Bike-Routing mit Effort-Coloring: Klick auf Startpunkt → Karte zeigt, **wohin man in X Stunden kommt – und was es an Höhenmetern kostet.** Farbe = Zeit, zweiter Kanal = kumulierte Höhenmeter, Steilheit ausschliesslich als Filter (nie als Kostenterm). Einstellbares Fahrer-Profil (v_flat : vam) und Steigungsfilter.

> **Spec-Update (v1.1): Kostenmodell rein zeitlich.** Nordstern: „Wohin komme ich in X Stunden – und was kostet es mich an Höhenmetern?“ Der frühere freie Parameter α ist ersetzt durch ein physikalisch begründetes Zeitmodell mit zwei Geschwindigkeiten (v_flat, vam). Der `climb_factor` ist damit kein UI-Knopf mehr, sondern ergibt sich intern als `cf = v_flat / vam`. Details unten in den betroffenen Abschnitten.

## Architektur

Drei Schichten, getrennt nach Änderungsfrequenz:

**Statisch (quartalsweiser Rebuild, CDN-cached):** Netz-Geometrie als PMTiles auf R2. MapLibre lädt nur Viewport-Tiles (KB-Bereich), Level-of-Detail via tippecanoe gratis. Der Worker kennt keine Geometrie.

**Dynamisch (pro Startpunkt / α-Änderung, klein):** Effort-Response als Float32-Binary `(edge_id → cost)`, wenige hundert KB schweizweit. Frontend joint per `setFeatureState` an die Tiles.

**Worker (Compute):** Lädt `graph.bin` (reine Topologie, CSR-Format) aus R2, hält es im Memory-Cache. Dijkstra/A* mit **rein zeitlichem Kostenmodell** `cost = dist / v_flat + ascent / vam` (Sekunden, wenn v_flat in m/s und vam in Hm/s), Slope-Hard-Filter als Query-Parameter. Gewichtsfunktion als **sum-Familie mit Parametern** `w = a·dist + b·ascent` (`a = 1/v_flat`, `b = 1/vam`) implementiert, austauschbar gehalten gegen ein späteres `minimax`-Metrik (Bottleneck-Shortest-Path für Minimax-Steilheit) – ohne Umbau des Routing-Cores.

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

Geschwindigkeiten kommen als **v_flat** (Flachgeschwindigkeit, m/s) und **vam** (vertikale Aufstiegsgeschwindigkeit, Hm/s = m/s) statt als α. Daraus intern `cf = v_flat / vam`. Ein `metric`-Parameter (v1 nur `"time"`) ist vorgesehen, damit später Minimax-Steilheit ohne API-Bruch dazukommt.

- `POST /effort-field` – `{lat, lon, v_flat, vam, max_slope?, metric?, max_cost?}` → Dijkstra-Baum vom gesnappten Start. Der Baum akkumuliert pro Node **drei** Werte: Zeit (= Kosten, s), kumulierte Höhenmeter entlang des kostenoptimalen Pfads, max. Steigung unterwegs. Response: Binary **`(edge_id u32, time f32, cum_ascent f32)`** für alle Edges unterm Max-Budget. `max_cost` in Sekunden, Default 8 h = 28 800 s (profil-unabhängig).
- `POST /route` – `{from, to, v_flat, vam, max_slope?, metric?}` → A* (admissible Heuristik: `1/v_flat · Luftlinie + 1/vam · max(0, Δh_netto)`); Response: edge_id-Sequenz + Summen (time, dist, ascent, descent, max_slope).
- `GET /snap` – Koordinate → nächster Graph-Node (Grid-Index).

Slope-Filter = Edges mit `max_slope > limit` beim Expandieren überspringen (Heuristik bleibt gültig). Steilheit ist **ausschliesslich Filter**, nie Kostenterm.

**Interner Fallback:** Wird kein Profil (v_flat, vam) übergeben, sondern nur `alpha`, greift die rationale α→cf-Abbildung (`cf = 8·α/(1−α)`, cap 200) und die Gewichtung `w = dist + cf·ascent` (Distanz-Äquivalent statt Sekunden). Nicht die UI-Abstraktion, nur eine Rückfallebene.

**Response-Grösse:** Das dritte f32-Feld (`cum_ascent`) kostet 4 Bytes mehr pro Edge und null zusätzliche Rechenzeit. Bei 8-h-Budget schweizweit nähert sich `/effort-field` einem Voll-Graph-Dump (~1,3 M Geom-Edges × 12 B ≈ 16 MB); Workers-gzip reduziert das deutlich. Kodierung (dense f32-Array indexiert nach edge_id vs. sparse Tripel) ist eine Serialisierungs-Entscheidung im Worker, ohne Format-Bruch änderbar.

## Frontend-Features v1 (React/Vite + MapLibre, CF Pages)

- Klick setzt Start → Effort-Coloring: Edges als dicke Linien (200 m reale Strichbreite, `line-cap: round`, zoomabhängig, min ~2 px) → wirkt wie 100-m-Buffer; verschmilzt im Mittelland zu Flächen, bleibt in Tälern ehrlich korridorförmig.
- Farbskala = Zeit-Bänder (direkt aus der Kosten-Zeit in Sekunden); 4–6 Stufen, farbenblind-tauglich. Zweiter Farbkanal (z. B. Sättigung/Muster) = kumulierte Höhenmeter aus dem `cum_ascent`-Feld.
- **Zwei Regler statt eines α-Sliders:**
  - **Profil (Flachfahrer ↔ Bergfahrer):** bestimmt das Verhältnis v_flat : vam, also `cf` und damit die Routenwahl. Ankerpunkte: *Flach* (30 km/h, 500 Hm/h), *Mixed* (27, 700), *Gebirge* (25, 900). Löst einen Worker-Call aus. Custom-Eingabe der beiden Zahlen als aufklappbare Option für Nutzer, die ihre Werte kennen.
  - **Fitness:** skaliert v_flat und vam mit **demselben** Faktor (z. B. 0.7×–1.3×). Da alle Kosten dadurch mit demselben Faktor multipliziert werden, ändert sich die optimale Route **nicht** – nur die absoluten Zeiten. Deshalb **rein clientseitig**, kein Worker-Call, kein Re-Routing; nur die Zeitwerte/Bandgrenzen werden neu skaliert (wie der Budget-Slider). Im Code explizit kommentieren, damit das nicht später „aus Versehen“ zu einem Request umgebaut wird.
  - *Genauigkeits-Vereinfachung (bewusst für v1):* „Fitness skaliert beide Werte gleich“ ist eine Näherung – reale Fitness verbessert VAM stärker als die Flachgeschwindigkeit. Akzeptiert, weil sie den Slider gratis interaktiv macht. Als Kommentar festhalten.
- max. Steigung → Filter, neuer Worker-Call. Budget-/Farbslider → rein clientseitig (Style-Änderung, null Netzwerk).
- Zweiter Klick → Route als Linie + Stats-Panel (Zeit, km, Hm auf/ab, max %).
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
- ~~Zeitmodell~~ **(gelöst, v1.1):** rein zeitlich, `cost = dist/v_flat + ascent/vam`, zwei Geschwindigkeiten aus dem Profil. Später Physikmodell aus KOM QOM (P(v) invertieren, VAM aus Fitness ableiten statt gleich skalieren).
- OSM-Filter-Details: welche highway-Typen rein (track/path mit surface-Tags?) – Entscheid vor Schritt 3, betrifft Rennrad- vs. Gravel-Profil.

## Kostenmodell v1.1 – Referenz

- **Gewicht** einer gerichteten Edge: `w = dist/v_flat + ascent/vam` Sekunden. Als sum-Familie `w = a·dist + b·ascent` mit `a = 1/v_flat`, `b = 1/vam`.
- **Route = argmin Zeit.** Weil `Zeit = (1/v_flat)·(dist + cf·ascent)` mit `cf = v_flat/vam`, ist der zeitoptimale Pfad identisch zum Pfad des früheren `dist + cf·ascent`-Modells (positiver Skalar). Der Routing-Core bleibt unverändert; nur die berichteten Kosten sind jetzt Sekunden.
- **A*-Heuristik** (admissible & konsistent): `h = a·Luftlinie + b·max(0, Δh_netto)`, mit dem bestehenden Sicherheitsfaktor `(1 − 2⁻¹⁶)` gegen Float-Überschätzung. Skalierung eines konsistenten Heuristik mit `c ≤ 1` bleibt konsistent.
- **Drei Akkumulatoren pro Node** (Dijkstra, entlang des kostenoptimalen Pfads): Zeit, kumulierte Höhenmeter, max. Steigung. Kostet null Extra-Rechenzeit; Voraussetzung für den zweiten Farbkanal.
- **Effort-Field pro Geom-Edge:** `time = min(cost[u], cost[v])` (Isochronen-Konvention, D2), `cum_ascent` = kumulierte Höhenmeter am selben (günstigeren) Endpunkt; bei Kosten-Gleichstand deterministisch der kleinere cum_ascent.
- **Binary-Graph-Format unverändert.** `graph.bin` speichert weiter dist/ascent/descent/max_slope pro gerichteter Edge; nur das Response-Format bekommt das `cum_ascent`-Feld.