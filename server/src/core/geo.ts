export interface LatLon {
  lat: number;
  lon: number;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
const METRES_PER_DEG_LAT = EARTH_RADIUS_M * DEG;

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Square box around a point. Longitude span is widened by 1/cos(lat) so the box is the same
 * size in metres at any latitude; clamped near the poles where that factor explodes.
 */
export function bboxAround(center: LatLon, halfSizeM: number): BBox {
  const dLat = halfSizeM / METRES_PER_DEG_LAT;
  const dLon = dLat / Math.max(0.01, Math.cos(center.lat * DEG));
  return {
    south: Math.max(-90, center.lat - dLat),
    north: Math.min(90, center.lat + dLat),
    west: center.lon - dLon,
    east: center.lon + dLon,
  };
}

export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east
  );
}

/**
 * Local planar projection (equirectangular) around an origin. Over the few kilometres a game
 * covers the error is far below GPS noise, and it turns point-to-segment maths into plain 2D.
 */
export class LocalProjection {
  private readonly cosLat: number;

  constructor(private readonly origin: LatLon) {
    this.cosLat = Math.max(0.01, Math.cos(origin.lat * DEG));
  }

  x(lon: number): number {
    return (lon - this.origin.lon) * METRES_PER_DEG_LAT * this.cosLat;
  }

  y(lat: number): number {
    return (lat - this.origin.lat) * METRES_PER_DEG_LAT;
  }

  toLatLon(x: number, y: number): LatLon {
    return {
      lat: this.origin.lat + y / METRES_PER_DEG_LAT,
      lon: this.origin.lon + x / (METRES_PER_DEG_LAT * this.cosLat),
    };
  }
}
