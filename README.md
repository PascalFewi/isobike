# isobike

**How far do you get by bike in two hours, and how much climbing does it cost?**

isobike is a reach map for cycling in Switzerland. Click a start point and the
whole country colours in by riding time, from pale gold nearby to deep night
blue at the edge of your budget. The time accounts for every climb: it comes from
swissALTI3D's 2 m terrain model along each road.

- **Reach, not just routes.** One click shows everywhere you can ride within
  0.5 to 16 hours.
- **Plan as you go.** Every further click adds a leg, and the colouring continues
  from the last point with the time already ridden on the clock.
- **Your pace.** Pick a profile (flat specialist ↔ climber) and your speed on the
  flat; filter by maximum gradient and by surface (road, gravel).
- **Take it along.** Elevation profile, per-leg stats and GPX export.

The road network comes from OpenStreetMap, the elevation from swisstopo. The
whole pipeline is open source, from the raw data to the map.

## Contributing

This is a young project, and help is very welcome: test rides and bug reports,
missing tags in OpenStreetMap, map design, or code. Start with
[CONTRIBUTING.md](CONTRIBUTING.md), which covers running it locally in a few
minutes, or open an issue to say hello.

More detail: [specs.md](specs.md) (design and cost model) ·
[build/](build/README.md) (data pipeline) · [deploy/](deploy/README.md) (data
files and hosting).

## Credits

Road network © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors (ODbL). Elevation and basemap © [swisstopo](https://www.swisstopo.admin.ch).
