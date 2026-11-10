import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { googleMapsUrl, SATELLITE_TILES } from '../sitePhoto.js';

// Imagery tiles load far faster than a large exported picture and stay sharp at every zoom.
const START_ZOOM = 18;
const MIN_ZOOM = 15;
const MAX_ZOOM = 20;
const SHARPEST_TILES = 18;

export default function PhotoViewer({ photo, onClose }) {
  const dialogRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    // No close() on cleanup: its close event would end up closing the viewer as soon as it opens.
    if (!dialogRef.current.open) dialogRef.current.showModal();
    const map = L.map(frameRef.current, { center: [photo.lat, photo.lon], zoom: START_ZOOM, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, attributionControl: false });
    L.tileLayer(SATELLITE_TILES, { maxNativeZoom: SHARPEST_TILES, maxZoom: MAX_ZOOM }).addTo(map);
    return () => map.remove();
  }, [photo]);

  return (
    <dialog
      ref={dialogRef}
      className="photo-viewer"
      aria-label={`Satellite picture of ${photo.title}`}
      onClose={onClose}
      onClick={(event) => event.target === dialogRef.current && dialogRef.current.close()}
    >
      <header className="photo-head">
        <div>
          <h2>{photo.title}</h2>
          {photo.address && <p>{photo.address}</p>}
        </div>
        <button type="button" className="photo-button" aria-label="Close picture" onClick={() => dialogRef.current.close()}>×</button>
      </header>

      <div ref={frameRef} className="photo-frame" role="application" aria-label={`Zoomable satellite picture of ${photo.title}`} />

      <footer className="photo-foot">
        <small>Imagery: Esri, Vantor, Earthstar Geographics, GIS User Community</small>
        <a className="photo-maps" href={googleMapsUrl(photo)} target="_blank" rel="noopener noreferrer">View on Google Maps ↗</a>
      </footer>
    </dialog>
  );
}
