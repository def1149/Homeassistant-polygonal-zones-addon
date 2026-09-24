/*
 * Live tracker overlay.
 *
 * Plots the positions the add-on serves from /trackers.json over the map, and
 * measures each one against the zones currently drawn — so "why is this device
 * not in that zone?" is answerable by looking rather than by reading the
 * integration's debug log.
 *
 * Two deliberate limits:
 *
 *  - It MEASURES, it does not PREDICT. The readout says "inside" or "3.8 m
 *    outside"; it never says which zone the integration would report. Those
 *    rules live in the integration and reimplementing them here would create a
 *    second source of truth that drifts (see js/geometry.js for the incident
 *    that motivated this).
 *  - It is silent unless the user opts in. With `overlay_entities` unset the
 *    endpoint reports `configured: false` and this module renders nothing at
 *    all — no panel, no error, no marker.
 */

const PZ_TRACKER_ENDPOINT = './trackers.json';
const PZ_TRACKER_REFRESH_MS = 60000;

/* Re-measure at most this often while the user drags a vertex. The maths is
 * cheap, but rebuilding the readout DOM on every mousemove is not. */
const PZ_MEASURE_THROTTLE_MS = 150;

let pz_tracker_layer = null;
let pz_trackers = [];
let pz_measure_timer = null;

/* Every ring of a layer, as GeoJSON [lon, lat] arrays, read from the LIVE
 * Leaflet geometry rather than layer.feature — so measurements track the shape
 * under the user's cursor, not the shape as last saved. */
function pz_layer_rings(layer) {
    if (typeof layer.getLatLngs !== 'function') return [];
    const rings = [];
    const walk = (nodes) => {
        if (!Array.isArray(nodes) || !nodes.length) return;
        if (nodes[0] instanceof L.LatLng) {
            const ring = nodes.map((p) => [p.lng, p.lat]);
            if (ring.length >= 3) {
                ring.push([ring[0][0], ring[0][1]]); // close it
                rings.push(ring);
            }
            return;
        }
        nodes.forEach(walk);
    };
    walk(layer.getLatLngs());
    return rings;
}

/* Total area of a zone in square metres, across all its rings. Lives here
 * rather than in geometry.js because it reads Leaflet layers; geometry.js is
 * kept free of any dependency so it can be exercised without a browser. */
function pz_layer_area_m2(layer) {
    return pz_layer_rings(layer).reduce((sum, ring) => sum + pz_ring_area_m2(ring), 0);
}

function pz_zone_name(layer) {
    return (layer.feature && layer.feature.properties && layer.feature.properties.name)
        || 'Unnamed zone';
}

/* Best (smallest) measurement across a multi-ring zone: a device is "in" a
 * MultiPolygon if it is in any of its parts. */
function pz_measure_zone(tracker, layer) {
    const rings = pz_layer_rings(layer);
    if (!rings.length) return null;
    let best = null;
    for (const ring of rings) {
        const m = pz_measure(tracker.longitude, tracker.latitude, ring, tracker.gps_accuracy);
        if (!best || (m.inside && !best.inside) || m.edgeDistanceM < best.edgeDistanceM) {
            best = m;
        }
    }
    return best;
}

function pz_format_metres(value) {
    if (!Number.isFinite(value)) return '—';
    return value < 10 ? `${value.toFixed(1)} m` : `${Math.round(value)} m`;
}

function pz_render_readout() {
    const panel = document.querySelector('.tracker-readout');
    if (!panel) return;
    panel.innerHTML = '';
    if (!pz_trackers.length) {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;

    const heading = document.createElement('h2');
    heading.textContent = 'Tracked devices';
    panel.appendChild(heading);

    pz_trackers.forEach((tracker) => {
        const card = document.createElement('div');
        card.className = 'tracker-card';

        const title = document.createElement('h3');
        title.textContent = tracker.name;
        card.appendChild(title);

        const meta = document.createElement('p');
        meta.className = 'tracker-meta';
        meta.textContent = tracker.gps_accuracy === null
            ? `${tracker.state} · no accuracy reported`
            : `${tracker.state} · ±${pz_format_metres(tracker.gps_accuracy)}`;
        card.appendChild(meta);

        const list = document.createElement('ul');
        list.className = 'tracker-zones';
        let any = false;
        editableLayers.eachLayer((layer) => {
            const m = pz_measure_zone(tracker, layer);
            if (!m) return;
            // Only zones worth mentioning: the ones it is in, or near enough
            // that a small drag would change the answer.
            const notable = m.inside || m.edgeDistanceM <= Math.max(50, (tracker.gps_accuracy || 0) * 2);
            if (!notable) return;
            any = true;
            const li = document.createElement('li');
            li.className = m.inside ? 'is-inside' : 'is-outside';
            const where = m.inside
                ? `inside, ${pz_format_metres(m.edgeDistanceM)} from the edge`
                : `${pz_format_metres(m.edgeDistanceM)} outside`;
            li.textContent = `${pz_zone_name(layer)} — ${where}`;
            if (!m.inside && m.withinAccuracy) {
                // Its error circle reaches the zone. Whether that counts is the
                // integration's call, not ours — say what we measured, not what
                // it will decide.
                li.textContent += ' (within its accuracy)';
            }
            list.appendChild(li);
        });
        if (!any) {
            const li = document.createElement('li');
            li.className = 'is-outside';
            li.textContent = 'Not in or near any zone';
            list.appendChild(li);
        }
        card.appendChild(list);
        panel.appendChild(card);
    });

    const note = document.createElement('p');
    note.className = 'tracker-note';
    note.textContent =
        'Distances are measured by this editor. Which zone the integration '
        + 'reports is decided by the integration, not shown here.';
    panel.appendChild(note);
}

function pz_render_markers() {
    if (!pz_tracker_layer) return;
    pz_tracker_layer.clearLayers();
    pz_trackers.forEach((tracker) => {
        const latlng = [tracker.latitude, tracker.longitude];
        if (Number.isFinite(tracker.gps_accuracy) && tracker.gps_accuracy > 0) {
            L.circle(latlng, {
                radius: tracker.gps_accuracy,
                className: 'tracker-accuracy',
                interactive: false,
            }).addTo(pz_tracker_layer);
        }
        L.circleMarker(latlng, { radius: 6, className: 'tracker-marker' })
            .bindTooltip(tracker.name, { permanent: false })
            .addTo(pz_tracker_layer);
    });
}

/* Re-measure after the shapes change. Throttled: dragging a vertex fires
 * continuously and the DOM rebuild is the expensive half. */
function pz_schedule_measure() {
    if (pz_measure_timer) return;
    pz_measure_timer = setTimeout(() => {
        pz_measure_timer = null;
        pz_render_readout();
    }, PZ_MEASURE_THROTTLE_MS);
}

function setup_tracker_overlay(mapInstance) {
    return fetch(PZ_TRACKER_ENDPOINT, { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
            // Not opted in (the default), or the endpoint refused us. Either
            // way the editor behaves exactly as it did before this feature.
            if (!body || !body.configured) return;
            if (body.error === 'no_supervisor_token') {
                console.warn(
                    'Tracker overlay is configured but the add-on has no Supervisor token — '
                    + 'check that homeassistant_api is enabled.',
                );
                return;
            }
            pz_trackers = Array.isArray(body.trackers) ? body.trackers : [];
            if (!pz_trackers.length) return;

            pz_tracker_layer = L.layerGroup().addTo(mapInstance);
            pz_render_markers();
            pz_render_readout();

            ['pz:zoneschanged', 'pm:create', 'pm:remove', 'pm:edit', 'pm:update']
                .forEach((evt) => mapInstance.on(evt, pz_schedule_measure));
            setInterval(() => {
                fetch(PZ_TRACKER_ENDPOINT, { headers: { Accept: 'application/json' } })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((body) => {
                        if (!body || !body.configured) return;
            
                        pz_trackers = Array.isArray(body.trackers) ? body.trackers : [];
                        pz_render_markers();
                        pz_render_readout();
                    })
                    .catch((err) => {
                        console.warn('Tracker overlay refresh failed:', err);
                    });
            }, PZ_TRACKER_REFRESH_MS);
        })
        .catch((err) => {
            // A missing overlay must never break the editor itself.
            console.warn('Tracker overlay unavailable:', err);
        });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pz_layer_rings, pz_layer_area_m2, pz_measure_zone, pz_format_metres };
}
