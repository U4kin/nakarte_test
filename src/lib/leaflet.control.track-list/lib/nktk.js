import Pbf from 'pbf';
import {TrackView} from './nktk_pb';
import {arrayBufferToString, stringToArrayBuffer} from 'lib/binary-strings';
import utf8 from 'utf8';
import config from 'config';

const arcUnit = ((1 << 24) - 1) / 360;

function encodeUrlSafeBase64(s) {
    return (btoa(s)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            // .replace(/=+$/, '')
    );
}

function decodeUrlSafeBase64(s) {
    var decoded;
    s = s
        .replace(/[\n\r \t]/g, '')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    try {
        decoded = atob(s);
    } catch (e) {
    }
    if (decoded && decoded.length) {
        return decoded;
    }
    return null;
}

function PackedStreamReader(s) {
    this._string = s;
    this.position = 0;
}

PackedStreamReader.prototype.readNumber = function() {
    var n = unpackNumber(this._string, this.position);
    this.position += n[1];
    return n[0];
};

PackedStreamReader.prototype.readString = function(size) {
    var s = this._string.slice(this.position, this.position + size);
    this.position += size;
    return s;
};

function unpackNumber(s, position) {
    var x,
        n = 0;
    x = s.charCodeAt(position);
    if (isNaN(x)) {
        throw new Error('Unexpected end of line while unpacking number');
    }
    if (x < 128) {
        n = x - 64;
        return [n, 1];
    }
    n = x & 0x7f;
    x = s.charCodeAt(position + 1);
    if (isNaN(x)) {
        throw new Error('Unexpected end of line while unpacking number');
    }
    if (x < 128) {
        n |= x << 7;
        n -= 8192;
        return [n, 2];
    }
    n |= (x & 0x7f) << 7;
    x = s.charCodeAt(position + 2);
    if (isNaN(x)) {
        throw new Error('Unexpected end of line while unpacking number');
    }
    if (x < 128) {
        n |= x << 14;
        n -= 1048576;
        return [n, 3];
    }
    n |= (x & 0x7f) << 14;
    x = s.charCodeAt(position + 3);
    if (isNaN(x)) {
        throw new Error('Unexpected end of line while unpacking number');
    }
    n |= x << 21;
    n -= 268435456;
    return [n, 4];
}

function deltaEncodeSegment(points) {
    let deltaLats = [],
        deltaLons = [];
    let lastLon = 0,
        lastLat = 0,
        lon, lat;
    for (let i = 0, len = points.length; i < len; i++) {
        let p = points[i];
        lon = Math.round(p.lng * arcUnit);
        lat = Math.round(p.lat * arcUnit);
        let deltaLon = lon - lastLon;
        let deltaLat = lat - lastLat;
        deltaLats.push(deltaLat);
        deltaLons.push(deltaLon);
        lastLon = lon;
        lastLat = lat;
    }
    return {deltaLats, deltaLons};
}

function deltaDecodeSegment(deltaLats, deltaLons) {
    let encodedLat = 0,
        encodedLon = 0;
    const points = [];
    for (let i = 0; i < deltaLats.length; i++) {
        encodedLat += deltaLats[i];
        encodedLon += deltaLons[i];
        points.push({lat: encodedLat / arcUnit, lng: encodedLon / arcUnit});
    }
    return points;
}

function packNumber(n) {
    var bytes = [];
    if (n >= -64 && n <= 63) {
        n += 64;
        bytes.push(n);
    } else if (n >= -8192 && n <= 8191) {
        n += 8192;
        bytes.push((n & 0x7f) | 0x80);
        bytes.push(n >> 7);
        /*        } else if (n >= -2097152 && n <= 2097151) {
         n += 2097152;
         bytes.push((n & 0x7f) | 0x80);
         bytes.push(((n >> 7) & 0x7f) | 0x80);
         bytes.push(n >> 14);
         */
    } else if (n >= -1048576 && n <= 1048575) {
        n += 1048576;
        bytes.push((n & 0x7f) | 0x80);
        bytes.push(((n >> 7) & 0x7f) | 0x80);
        bytes.push(n >> 14);
    } else if (n >= -268435456 && n <= 268435455) {
        n += 268435456;
        bytes.push((n & 0x7f) | 0x80);
        bytes.push(((n >> 7) & 0x7f) | 0x80);
        bytes.push(((n >> 14) & 0x7f) | 0x80);
        bytes.push(n >> 21);
    } else {
        throw new Error('Number ' + n + ' too big to pack in 29 bits');
    }
    return String.fromCharCode.apply(null, bytes);
}

function saveNktk(segments, name, color, measureTicksShown, wayPoints, trackHidden) {
    var stringified = [];
    stringified.push(packNumber(3)); // version
    name = utf8.encode(name);
    stringified.push(packNumber(name.length));
    stringified.push(name);

    var arcUnit = ((1 << 24) - 1) / 360;
    segments = segments.filter(function(segment) {
            return segment.length > 1;
        }
    );

    stringified.push(packNumber(segments.length));
    segments.forEach(function(points) {
            var lastX = 0,
                lastY = 0,
                x, y,
                deltaX, deltaY,
                p;
            stringified.push(packNumber(points.length));
            for (var i = 0, len = points.length; i < len; i++) {
                p = points[i];
                x = Math.round(p.lng * arcUnit);
                y = Math.round(p.lat * arcUnit);
                deltaX = x - lastX;
                deltaY = y - lastY;
                stringified.push(packNumber(deltaX));
                stringified.push(packNumber(deltaY));
                lastX = x;
                lastY = y;
            }
        }
    );
    stringified.push(packNumber(+color || 0));
    stringified.push(packNumber(measureTicksShown ? 1 : 0));
    stringified.push(packNumber(trackHidden ? 1 : 0));

    stringified.push(packNumber(wayPoints.length));
    if (wayPoints.length) {
        var midX = 0, midY = 0;
        wayPoints.forEach(function(p) {
                midX += p.latlng.lng;
                midY += p.latlng.lat;
            }
        );
        midX = Math.round(midX * arcUnit / wayPoints.length);
        midY = Math.round(midY * arcUnit / wayPoints.length);
        stringified.push(packNumber(midX));
        stringified.push(packNumber(midY));
        wayPoints.forEach(function(p) {
                var deltaX = Math.round(p.latlng.lng * arcUnit) - midX,
                    deltaY = Math.round(p.latlng.lat * arcUnit) - midY,
                    symbol = 1,
                    name = utf8.encode(p.label);
                stringified.push(packNumber(name.length));
                stringified.push(name);
                stringified.push(packNumber(symbol));
                stringified.push(packNumber(deltaX));
                stringified.push(packNumber(deltaY));
            }
        );
    }

    return encodeUrlSafeBase64(stringified.join(''));
}

function parseTrackUrlData(s) {
    s = decodeUrlSafeBase64(s);
    if (!s) {
        return [{name: 'Text encoded track', error: ['CORRUPT']}];
    }
    return parseNktkOld(s, 0);
}

function parseNktkOld(s, version) {
    var name,
        n,
        segments = [],
        segment,
        segmentsCount,
        pointsCount,
        arcUnit = ((1 << 24) - 1) / 360,
        x, y,
        error, midX, midY, /*symbol,*/ waypointName,
        wayPoints = [], color, measureTicksShown, trackHidden = false;
    s = new PackedStreamReader(s);
    try {
        n = s.readNumber();
        name = s.readString(n);
        name = utf8.decode(name);
        segmentsCount = s.readNumber();
        for (; segmentsCount--;) {
            segment = [];
            pointsCount = s.readNumber();
            x = 0;
            y = 0;
            for (; pointsCount--;) {
                x += s.readNumber();
                y += s.readNumber();
                segment.push({lng: x / arcUnit, lat: y / arcUnit});
            }
            segments.push(segment);
            segment = null;
        }
    } catch (e) {
        if (e.message.match('Unexpected end of line while unpacking number')) {
            error = ['CORRUPT'];
            if (segment) {
                segments.push(segment);
            }
        } else {
            throw e;
        }
    }
    try {
        color = s.readNumber();
        measureTicksShown = s.readNumber();
    } catch (e) {
        if (e.message.match('Unexpected end of line while unpacking number')) {
            color = 0;
            measureTicksShown = 0;
            if (version > 0) {
                error = ['CORRUPT'];
            }
        } else {
            throw e;
        }
    }
    if (version >= 3) {
        try {
            trackHidden = !!(s.readNumber())
        } catch (e) {
            if (e.message.match('Unexpected end of line while unpacking number')) {
                error = ['CORRUPT'];
            } else {
                throw e;
            }
        }
    }
    if (version >= 2) {
        try {
            pointsCount = s.readNumber();
            if (pointsCount) {
                midX = s.readNumber();
                midY = s.readNumber();
            }
            for (; pointsCount--;) {
                n = s.readNumber();
                waypointName = s.readString(n);
                waypointName = utf8.decode(waypointName);

                // let symbol = s.readNumber();
                s.readNumber();

                x = s.readNumber() + midX;
                y = s.readNumber() + midY;
                wayPoints.push({
                        name: waypointName,
                        lat: y / arcUnit,
                        lng: x / arcUnit,

                    }
                );
            }
        } catch (e) {
            if (e.message.match('Unexpected end of line while unpacking number')) {
                error = ['CORRUPT'];
            } else {
                throw e;
            }
        }
    }
    var geoData = {
        name: name || "Text encoded track",
        tracks: segments,
        error: error,
        points: wayPoints,
        color: color,
        measureTicksShown: measureTicksShown,
        trackHidden: trackHidden
    };
    return [geoData];
}

function parseNktkProtobuf(s) {
    const pbf = new Pbf(stringToArrayBuffer(s));
    let trackView;
    try {
        trackView = TrackView.read(pbf);
    } catch (e) {
        return [{name: 'Text encoded track', error: ['CORRUPT']}];
    }
    const geoData = {
        name: trackView.track.name || "Text encoded track",
        color: trackView.view.color,
        trackHidden: !trackView.view.shown,
        measureTicksShown: trackView.view.ticksShown,
    };
    const segments = trackView.track.segments;
    if (segments && segments.length) {
        geoData.tracks = segments.map((segment) => deltaDecodeSegment(segment.lats, segment.lons));
    }
    if (trackView.track.waypoints && trackView.track.waypoints.waypoints.length) {
        const waypoints = geoData.points = [];
        for (let waypoint of trackView.track.waypoints.waypoints) {
            waypoints.push({
                name: waypoint.name,
                lat: (waypoint.lat + trackView.track.waypoints.midLat) / arcUnit,
                lng: (waypoint.lon + trackView.track.waypoints.midLon) / arcUnit
            });
        }
    }
    return [geoData];

}

function parseNktkFragment(s) {
    s = decodeUrlSafeBase64(s);
    if (!s) {
        return [{name: 'Text encoded track', error: ['CORRUPT']}];
    }
    const reader = new PackedStreamReader(s);
    let version = reader.readNumber();
    if (version === 1 || version === 2 || version === 3) {
        return parseNktkOld(s.substring(reader.position), version);
    } else if (version === 4) {
        return parseNktkProtobuf(s.substring(reader.position));
    } else {
        return [{name: 'Text encoded track', error: ['CORRUPT']}];
    }
}

function parseNktkSequence(s) {
    if (typeof s === "string") {
        s = s.split('/');
    }
    var geodataArray = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i]) {
            geodataArray.push.apply(geodataArray, parseNktkFragment(s[i]));
        }
    }
    return geodataArray;
}


function parseNakarteUrl(s) {
    let i = s.indexOf('#');
    if (i === -1) {
        return null;
    }
    i = s.indexOf('nktk=', i + 1);
    if (i === -1) {
        return null;
    }
    s = s.substring(i + 5);
    return parseNktkSequence(s)
}


const nakarteLinkRe = /#.*nktl=([A-Z-a-z0-9_-]+)/;


function isNakarteLinkUrl(url) {
    return nakarteLinkRe.test(url);
}


function nakarteLinkXhrOptions(url) {
    const m = nakarteLinkRe.exec(url);
    if (!m) {
        throw new Error('Invalid nakarteLink url');
    }
    const trackId = m[1];
    return [{url: (`${config.tracksStorageServer}/track/${trackId}`), options: {responseType: 'binarystring'}}]
}

function nakarteLinkParser(_, responses) {
    if (responses.length !== 1) {
        throw new Error(`Invalid responses array length ${responses.length}`);
    }
    return parseNktkSequence(responses[0].responseBinaryText);
}

export {saveNktk, parseTrackUrlData, parseNakarteUrl, isNakarteLinkUrl, nakarteLinkXhrOptions, nakarteLinkParser, parseNktkSequence};