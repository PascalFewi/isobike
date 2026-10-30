/**
 * Cycling points of interest from OpenStreetMap (`pois.pmtiles`, built by
 * `build/pois.py`): what each kind is called, from which zoom it shows, and its
 * map icon.
 *
 * The icons are drawn here on a canvas rather than shipped as a sprite: simple
 * pictograms on a coloured badge with a white ring, so they read on the grey
 * map, the aerial photo and OSM alike. One colour per group -- bike service
 * green, food brown, lodging teal, toilets and shelter grey, water and parking
 * their sign blue -- and all clear of the reach palette (gold -> rose -> night
 * blue), so an icon never reads as a time band.
 */

/** Same order as `POI_KINDS` in build/pois.py: the legend order. */
export const POI_KINDS = [
  'water', 'repair', 'pump', 'shop', 'rental', 'charging', 'parking',
  'food', 'cafe', 'restaurant', 'lodging', 'toilets', 'shelter',
] as const;
export type PoiKind = (typeof POI_KINDS)[number];

interface KindInfo {
  readonly label: string;
  readonly color: string;
  /**
   * First zoom the kind shows at; dense kinds wait for closer zooms. Keep in step
   * with `KIND_MINZOOM` in build/pois.py, which leaves the kind out of the tiles
   * below it.
   */
  readonly minzoom: number;
}

const BIKE = '#2e7d32';
const FOOD = '#795548';
const STAY = '#00838f';
const BASIC = '#616161';

export const POI_INFO: Readonly<Record<PoiKind, KindInfo>> = {
  water: { label: 'Trinkwasser', color: '#1e88e5', minzoom: 13 },
  repair: { label: 'Velo-Reparaturstation', color: BIKE, minzoom: 12 },
  pump: { label: 'Luftpumpe', color: BIKE, minzoom: 13 },
  shop: { label: 'Velogeschäft', color: BIKE, minzoom: 12 },
  rental: { label: 'Veloverleih', color: BIKE, minzoom: 13 },
  charging: { label: 'E-Bike-Ladestation', color: BIKE, minzoom: 13 },
  parking: { label: 'Veloparkplatz', color: '#1565c0', minzoom: 15 },
  food: { label: 'Einkaufen', color: FOOD, minzoom: 13 },
  cafe: { label: 'Café', color: FOOD, minzoom: 14 },
  restaurant: { label: 'Restaurant', color: FOOD, minzoom: 15 },
  lodging: { label: 'Unterkunft', color: STAY, minzoom: 13 },
  toilets: { label: 'Toilette', color: BASIC, minzoom: 15 },
  shelter: { label: 'Unterstand', color: BASIC, minzoom: 14 },
};

/** Popup label for the `sub` property: which lodging or food shop it is. */
export const POI_SUB_LABELS: Readonly<Record<string, string>> = {
  hotel: 'Hotel',
  motel: 'Motel',
  hostel: 'Hostel',
  guest_house: 'Pension',
  camp_site: 'Camping',
  alpine_hut: 'Berghütte',
  wilderness_hut: 'Biwak / Hütte',
  supermarket: 'Supermarkt',
  convenience: 'Laden',
  bakery: 'Bäckerei',
};

/** Map image id of a kind's icon: this prefix plus the kind. */
export const POI_IMAGE_PREFIX = 'poi-';
export const poiImageId = (kind: PoiKind): string => `${POI_IMAGE_PREFIX}${kind}`;

/** Icon size in CSS pixels; drawn at 2x for sharp edges on high-DPI screens. */
const SIZE = 22;
export const POI_PIXEL_RATIO = 2;
const S = SIZE * POI_PIXEL_RATIO;

/** The kind's icon on a fresh canvas, {@link POI_PIXEL_RATIO} x its CSS size. */
function drawIcon(kind: PoiKind): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const { color } = POI_INFO[kind];
  const c = S / 2;

  // Badge: a white ring around the kind's colour; parking is the square P sign.
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  if (kind === 'parking') {
    roundRect(ctx, 1, 1, S - 2, S - 2, 8);
    ctx.fill();
    ctx.fillStyle = color;
    roundRect(ctx, 4, 4, S - 8, S - 8, 6);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(c, c, c - 4, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'water':
      ctx.beginPath();
      ctx.moveTo(22, 10);
      ctx.bezierCurveTo(26, 16, 31, 21, 31, 26);
      ctx.arc(22, 26, 9, 0, Math.PI);
      ctx.bezierCurveTo(13, 21, 18, 16, 22, 10);
      ctx.fill();
      break;
    case 'repair':
      // An open-ended spanner, tilted.
      ctx.translate(c, c);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-2.5, -4, 5, 17);
      ctx.beginPath();
      ctx.arc(0, -7, 6.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillRect(-2.5, -15, 5, 8);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      break;
    case 'shop':
    case 'rental':
      bicycle(ctx);
      if (kind === 'rental') {
        // A small key on the frame tells rental from shop.
        ctx.beginPath();
        ctx.arc(22, 11, 3, 0, 2 * Math.PI);
        ctx.stroke();
      }
      break;
    case 'pump':
      // A floor pump: T handle, barrel, foot.
      ctx.fillRect(15, 10, 14, 3);
      ctx.fillRect(20.5, 12, 3, 5);
      roundRect(ctx, 18, 16, 8, 15, 2);
      ctx.fill();
      ctx.fillRect(13, 31, 18, 3);
      break;
    case 'food':
      // A shopping basket.
      ctx.beginPath();
      ctx.moveTo(11, 20);
      ctx.lineTo(33, 20);
      ctx.lineTo(30, 33);
      ctx.lineTo(14, 33);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(22, 20, 7, Math.PI, 0);
      ctx.stroke();
      break;
    case 'cafe':
      // A cup on a saucer.
      ctx.beginPath();
      ctx.moveTo(12, 16);
      ctx.lineTo(28, 16);
      ctx.lineTo(26.5, 29);
      ctx.lineTo(13.5, 29);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(28, 21.5, 4, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      ctx.fillRect(10, 31, 20, 2.5);
      break;
    case 'restaurant':
      // Fork and knife.
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (const x of [13.5, 16.5, 19.5]) {
        ctx.moveTo(x, 10);
        ctx.lineTo(x, 16);
      }
      ctx.moveTo(13.5, 16);
      ctx.quadraticCurveTo(16.5, 21, 19.5, 16);
      ctx.moveTo(16.5, 19);
      ctx.lineTo(16.5, 34);
      ctx.moveTo(28, 21);
      ctx.lineTo(28, 34);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(28, 10);
      ctx.quadraticCurveTo(33, 15, 31, 22);
      ctx.lineTo(28, 22);
      ctx.closePath();
      ctx.fill();
      break;
    case 'lodging':
      // A bed: headboard, pillow, blanket, frame.
      ctx.fillRect(10, 15, 3, 18);
      ctx.fillRect(10, 26, 24, 4);
      ctx.fillRect(31, 26, 3, 7);
      ctx.beginPath();
      ctx.arc(17.5, 22, 3, 0, 2 * Math.PI);
      ctx.fill();
      roundRect(ctx, 22, 19, 12, 6, 2);
      ctx.fill();
      break;
    case 'toilets':
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('WC', c, c + 1);
      break;
    case 'shelter':
      // A roof on two posts.
      ctx.beginPath();
      ctx.moveTo(9, 22);
      ctx.lineTo(22, 11);
      ctx.lineTo(35, 22);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(13, 21, 3, 13);
      ctx.fillRect(28, 21, 3, 13);
      break;
    case 'charging':
      ctx.beginPath();
      ctx.moveTo(25, 8);
      ctx.lineTo(14, 24);
      ctx.lineTo(21, 24);
      ctx.lineTo(18, 36);
      ctx.lineTo(30, 19);
      ctx.lineTo(23, 19);
      ctx.closePath();
      ctx.fill();
      break;
    case 'parking':
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', c, c + 1);
      break;
  }
  return canvas;
}

function bicycle(ctx: CanvasRenderingContext2D): void {
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(14, 27, 6, 0, 2 * Math.PI);
  ctx.moveTo(36, 27);
  ctx.arc(30, 27, 6, 0, 2 * Math.PI);
  // Frame: rear hub -> seat -> head tube -> front hub, plus the down tube.
  ctx.moveTo(14, 27);
  ctx.lineTo(19, 18);
  ctx.lineTo(28, 18);
  ctx.lineTo(30, 27);
  ctx.moveTo(19, 18);
  ctx.lineTo(23, 27);
  ctx.lineTo(28, 18);
  ctx.moveTo(14, 27);
  ctx.lineTo(23, 27);
  ctx.moveTo(17, 16);
  ctx.lineTo(21, 16);
  ctx.moveTo(27, 15);
  ctx.lineTo(28, 18);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Pixels for `map.addImage` (with `pixelRatio: POI_PIXEL_RATIO`). */
export function poiImage(kind: PoiKind): ImageData {
  return drawIcon(kind).getContext('2d')!.getImageData(0, 0, S, S);
}

const urls = new Map<PoiKind, string>();
/** The same icon as an image URL, for the legend. */
export function poiIconUrl(kind: PoiKind): string {
  let url = urls.get(kind);
  if (url === undefined) {
    url = drawIcon(kind).toDataURL('image/png');
    urls.set(kind, url);
  }
  return url;
}
