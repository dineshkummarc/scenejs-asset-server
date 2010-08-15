/*
 Copyright (c) 2010 Lindsay Kay <lindsay.kay@xeolabs.com>

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
 */

var sys = require("sys");

var fs = require('fs');
var path = require("path");
var http = require("http");
var url = require("url");
var log = require('../../lib/log').log;
var uuid = require('../../lib/uuid');
var couchdb = require('../../lib/node-couchdb/couchdb'); // Node-CouchDB: http://github.com/felixge/node-couchdb
var jsonLib = require('../../lib/scenejs-utils/scenejs-json-builder');

var settings;
var client;
var db;

/* Intersection results for kd-map
 */
const INTERSECT_OUTSIDE = 0;
const INTERSECT_INSIDE = 1;
const INTERSECT_PARTIAL = 2;

/* Max depth of kd-map - when this exceeded during insertion descent,
 * asset is inserted into watever node we stopped at descent
 */
const MAX_DEPTH = 500;

/* The kd-tree
 */
var map;

/* Nodes in kd-tree, mapped to their IDs
 */
var nodes;


const DB_NAME = "scenejs-asset-map";

/*----------------------------------------------------------------------------------------------------------------------
 * Starts the Asset Map service
 *
 * - loads the whole k-d tree into memory for fast access
 *--------------------------------------------------------------------------------------------------------------------*/

exports.start = function(_settings, cb) {
    settings = _settings;

    /* Connect to DB
     */
    log("AssetServer.AssetMap: connecting to CouchDB at " + settings.db.host + ":" + settings.db.port);
    try {
        client = couchdb.createClient(settings.db.port, settings.db.host);
        db = client.db(DB_NAME);
    } catch (e) {
        throw "AssetServer.AssetMap: FAILED to connect to CouchDB: " + e;
    }

    db.exists(
            function(error, exists) {
                if (error) {
                    throw JSON.stringify(error);
                }
                if (!exists) {

                    /* AssetMap DB not found
                     */
                    log("AssetServer.AssetMap: did not find DB '" + DB_NAME + "' - that's OK I'll make one..");

                    /* Create DB and map
                     */
                    db.create(
                            function(error) {
                                log("AssetServer.AssetMap: creating DB '" + DB_NAME + "'");
                                if (error) {
                                    log("AssetServer.AssetMap: failed to create CouchDB database: " + JSON.stringify(error));
                                    throw "AssetServer.AssetMap: failed to create CouchDB database";
                                }

                                /* Create map in DB - root node to begin with
                                 */
                                log("AssetServer.AssetMap: creating map");
                                map = {
                                    id: "root",
                                    boundary: { xmin: -100000, ymin: -100000, zmin: -100000, xmax: 100000, ymax: 100000, zmax: 100000 },
                                    assets: [
                                    ]
                                };
                                nodes = {
                                    "root" : map
                                };
                                db.saveDoc("map", map,
                                        function(error, doc) {
                                            if (error) {
                                                throw "AssetServer.AssetMap: failed to create map: " + JSON.stringify(error);
                                            }

                                            /* Keep the revision number so we can
                                             * overwrite - we only want one version
                                             */
                                            map.rev = doc.rev;
                                            log("AssetServer.AssetMap: created map OK: " + JSON.stringify(map));
                                            if (cb) {
                                                cb();
                                            }
                                        });
                            });
                } else {

                    /* DB exists - load map
                     */
                    loadMap(function(result) {
                        if (result.error) {
                            throw "AssetServer.AssetMap: failed to load map from DB: " + error;
                        }
                        map = result.body;
                        nodes = getMapNodeIds(map);
                        if (cb) {
                            cb();
                        }
                    });
                }
            });
};

/** Creates ID map of kd-tree nodes
 */
function getMapNodeIds(node, nodes) {
    if (!nodes) {
        nodes = {};
    }
    nodes[node.id] = node;
    if (node.leftChild) {
        getMapNodeIds(node.leftChild, nodes);
    }
    if (node.rightChild) {
        getMapNodeIds(node.rightChild, nodes);
    }
    return nodes;
}


/** Loads map
 */
function loadMap(cb) {
    log("AssetServer.AssetMap: loading map");
    db.getDoc("map",
            function(error, mapDoc) {
                if (error) {
                    cb({ error: 500, body: JSON.stringify(error) });
                } else {
                    cb({ body: mapDoc });
                }
            });
}

/** Saves map, overwriting existing document
 */
function saveMap(cb) {
    log("AssetServer.AssetMap: saving map");
    db.removeDoc("map", map.rev,
            function(error) {
                if (error) {
                    log("AssetMap failed to remove map: " + JSON.stringify(error));
                    throw "AssetMap failed to remove map";
                }
                map.rev = undefined;  // Gross HACK
                db.saveDoc("map", map,
                        function(error, doc) {
                            if (error) {
                                log("AssetMap failed to save map: " + JSON.stringify(error));
                                throw "AssetMap failed to save map";
                            }
                            map.rev = doc.rev;
                            cb(map);
                        });
            });
}

/*---------------------------------------------------------------------------------------------------------------------
 * Returns the Asset Map's kd-tree
 *
 *--------------------------------------------------------------------------------------------------------------------*/
exports.getAssetMap = function(params, cb) {
    log("AssetServer.AssetMap: getAssetMap");
    cb({ body: map });
};


/*----------------------------------------------------------------------------------------------------------------------
 * Services a client scene graph Socket node's request for a tree of BoundingBoxes corresonding to the
 * asset map kd-tree
 *
 *--------------------------------------------------------------------------------------------------------------------*/
exports.getAssetMapBoundingBoxes = function(params, cb) {
    log("AssetServer.AssetMap: getAssetMapBoundingBoxes");
    if (params.mode) {
        if (params.mode != "basic" && params.mode != "staging") {
            cb({
                error: 501,
                body: "getAssetMapBoundingBoxes.mode not supported: '" +
                      params.mode + "' - supported modes are 'basic' and 'staging'"});
            return;
        }
    } else {
        params.mode = "basic";
    }

    var builder = jsonLib.newBuilder({
        numIndents: 4,
        api : "function"
    });
    createBoundingBox(map, builder, mode);
    cb({
        format : "json",
        body: "{ configs: { " +
              "\"#assetMap\": { \"+node\": " +
              builder.getJSON() +
              " } } }"
    });
};

function createBoundingBox(node, builder, mode) {
    builder.openNode("boundingBox", {
        cfg: {
            sid: node.id,

            xmin: node.boundary.xmin,
            ymin: node.boundary.ymin,
            zmin: node.boundary.zmin,
            xmax: node.boundary.xmax,
            ymax: node.boundary.ymax,
            zmax: node.boundary.zmax,

            listeners: {
                "state-changed" : function(params) {
                    this.fireEvent("kd-event", {
                        newState: params.newState
                    });
                }
            }
        }
    });
    if (node.leftChild) {
        createBoundingBox(node.leftChild, builder, mode);
    }
    if (node.rightChild) {
        createBoundingBox(node.rightChild, builder, mode);
    }
    builder.closeNode();
}


/*----------------------------------------------------------------------------------------------------------------------
 * Services a request that notifies the server of batches of BoundingBox intersection state changes and gets
 * any assets the server then provides for kd-nodes that have either become visible or are likely to become visible
 *
 *--------------------------------------------------------------------------------------------------------------------*/
exports.getAssetMapUpdates = function(params, getAssetFunc, cb) {
    log("AssetServer.AssetMap: getAssetMapUpdates");

    var configs = {};
    var len = params.events.length;
    var event;
    for (var i = 0; i < len; i++) {
        event = params.events[i];
        switch (event.event) {

            case "gone":
                break;

            case "distant":
                break;

            case "near":
                var sids = event.nodeURI.split("/");
                createConfigs(
                        configs,
                        map,
                        sids.slice(1), // Descend past Socket's "assetMap" child to the root BoundingBox
                        event.nodeURI,
                        getAssetFunc,
                        function (error) {
                            if (error) {
                                cb({ error: 501, body: error });
                            } else {
                                cb({
                                    format : "json",
                                    body: "{ configs: " + JSON.stringify(configs) + "}"
                                });
                            }
                        });
                break;

            case "visible":
                break;
        }
    }
};


/////////////// Allow +node values to be string JSON


function createConfigs(configs, node, sids, nodeURI, getAssetFunc, cb) {
    var id = sids[0];
    var childNode = (id == "a") ? node.leftChild : node.rightChild;
    if (childNode) {
        var sid = "#" + id;
        var childConfigs = configs[sid];         // Create configs submap if not yet existing
        if (!childConfigs) {
            childConfigs = configs[sid] = {};
        }
        if (sids.length == 1) {

            /* At terminal BoundingBox - get assets
             */


        } else {
            createConfigs(
                    childConfigs,
                    childNode,
                    sids.slice(1), // Descend to next BoundingBox down on SID path
                    nodeURI,
                    getAssetFunc,
                    cb);
        }
    }
}

/*---------------------------------------------------------------------------------------------------------------------
 * Inserts an asset into the Asset Map
 *
 * TODO: Queue inserts to avoid race condition
 *
 * - inserts the asset into the kd-tree
 * - writes elements created in kd-tree through to DB
 *--------------------------------------------------------------------------------------------------------------------*/
exports.insertAsset = function(params, cb) {
    if (!params.assetId) {
        cb({ error: 501, body: "insertAsset.assetId expected" });
    } else if (!params.boundary) {
        cb({ error: 501, body: "insertAsset.boundary" });
    } else {

        log("AssetServer.AssetMap: insertAsset - " + JSON.stringify(params));
        var asset = { assetId: params.assetId, boundary: params.boundary };
        if (insertAsset(map, asset, 0, 0)) {
            saveMap(function() {
                        log("AssetMap insertAsset - OK");
                        cb({ body: {} });
                    });
        } else {
            cb({ error: 501, body: "AssetServer.AssetMap: insertAsset FAILED - outside of map boundary!" });
        }
    }
};

function insertAsset(node, asset, axis, recursionDepth) {

    log("AssetServer.AssetMap: insertAsset - node.id:" + node.id + ", axis:" + axis + ", recursionDepth:" + recursionDepth);

    if (intersectsBoundary(asset.boundary, node.boundary) == INTERSECT_OUTSIDE) { // Asset outside root boundary
        return false;
    }

    recursionDepth++;

    if (recursionDepth >= MAX_DEPTH) { // Max hierarchy depth reached
        log("AssetServer.AssetMap: insertAsset - at max depth - inserting into current node");
        node.assets.push(asset);
        return true;
    }

    axis = (axis + 1) % 3;

    var leftBoundary = halfBoundary(node.boundary, axis, -1);
    var intersect = intersectsBoundary(asset.boundary, leftBoundary);
    switch (intersect) {
        case INTERSECT_INSIDE: // Inside left boundary - insert into left child
            if (!node.leftChild) {
                node.leftChild = {
                    id:  "map-" + uuid.uuidFast(),
                    boundary: leftBoundary,
                    assets: []
                };
            }
            return insertAsset(node.leftChild, asset, axis, recursionDepth, cb);

        case INTERSECT_PARTIAL: // Overlaps left and right child boundaries - insert into this node
            node.assets.push(asset);
            return true;

        case INTERSECT_OUTSIDE: // Outside left boundary - insert into right child
            var rightBoundary = halfBoundary(node.boundary, axis, 1);
            if (!node.rightChild) {
                node.rightChild = {
                    id:  "map-" + uuid.uuidFast(),
                    boundary: rightBoundary,
                    assets: []
                };
            }
            return insertAsset(node.rightChild, asset, axis, recursionDepth, cb);
    }
}

/** Create inverse boundary ready for expansion
 */
function newInsideOutBoundary() {
    return { xmin: 1000000.0, ymin: 1000000.0,zmin: 1000000.0, xmax: -1000000.0, ymax: -1000000.0,zmax: -1000000.0 };
}

/** Returns positive/negative half of the given boundary, split on given axis,
 */
function halfBoundary(b, axis, sign) {
    if (axis == 0) {
        var xmid = (b.xmax + b.xmin) / 2.0;
        return (sign < 0) ?
               { xmin: b.xmin, ymin: b.ymin, zmin: b.zmin, xmax: xmid,   ymax: b.ymax, zmax: b.zmax } :
               { xmin: xmid,   ymin: b.ymin, zmin: b.zmin, xmax: b.xmax, ymax: b.ymax, zmax: b.zmax };
    } else if (axis == 1) {
        var ymid = (b.ymax + b.ymin) / 2.0;
        return (sign < 0) ?
               { xmin: b.xmin, ymin: b.ymin, zmin: b.zmin, xmax: b.xmax, ymax: ymid,   zmax: b.zmax } :
               { xmin: b.xmin, ymin: ymid,   zmin: b.zmin, xmax: b.xmax, ymax: b.ymax, zmax: b.zmax };
    } else {
        var zmid = (b.zmax + b.zmin) / 2.0;
        return (sign < 0) ?
               { xmin: b.xmin, ymin: b.ymin, zmin: b.zmin, xmax: b.xmax, ymax: b.ymax, zmax: zmid } :
               { xmin: b.xmin, ymin: b.ymin, zmin: zmid,   xmax: b.xmax, ymax: b.ymax, zmax: b.zmax };
    }
}

/** Returns intersection status of boundary A with B
 */
function intersectsBoundary(a, b) {
    if (a.xmax < b.xmin ||
        a.xmin > b.xmax ||
        a.ymax < b.ymin ||
        a.ymin > b.ymax ||
        a.zmax < b.zmin ||
        a.zmin > b.zmax) {
        log("intersectsBoundary INTERSECT_OUTSIDE : a=" + JSON.stringify(a) + ", b=" + JSON.stringify(b))
        return INTERSECT_OUTSIDE; // A entirely outside B
    }
    if (a.xmax <= b.xmax &&
        a.ymax <= b.ymax &&
        a.zmax <= b.zmax &&
        a.xmin >= b.xmin &&
        a.ymin >= b.ymin &&
        a.zmin >= b.zmin) {
        log("intersectsBoundary INTERSECT_INSIDE : a=" + JSON.stringify(a) + ", b=" + JSON.stringify(b))
        return INTERSECT_INSIDE;  // A entirely inside B
    }
    log("intersectsBoundary INTERSECT_PARTIAL : a=" + JSON.stringify(a) + ", b=" + JSON.stringify(b))
    return INTERSECT_PARTIAL;     // A overlaps B
}


/*---------------------------------------------------------------------------------------------------------------------
 * Removes an asset from the Asset Map
 *
 * - finds node in kd-tree
 * - removes asset from node
 * - if node then has no assets, removes it else writes changes
 *--------------------------------------------------------------------------------------------------------------------*/
exports.removeAsset = function(params, cb) {
    log("AssetServer.AssetMap: removeAsset");
    if (!params.assetId) {
        cb({ error: 501, body: "removeAsset.assetId expected" });
    } else if (!params.boundary) {
        cb({ error: 501, body: "removeAsset.boundary" });
    } else {
        var asset = { assetId: params.assetId, boundary: params.boundary };
        if (removeAsset(map, asset, 0, 0)) {
            cb({ body: {} });
        } else {
            cb({ error: 501, body: "asset boundary too big" });
        }
    }
};

function removeAsset(node, asset, axis, recursionDepth, cb) {
    axis = (axis + 1) % 3;
    if (intersectsBoundary(asset.boundary, node.boundary) != INTERSECT_INSIDE) { // Asset outside root boundary
        cb("AssetServer.AssetMap: outside root node boundary");
        return;
    }

    recursionDepth++;
    if (recursionDepth >= MAX_DEPTH) { // Max hierarchy depth reached
        var index = getAssetIndex(node, asset);
        if (index > -1) {
            if (node.assets.length == 0) {
                /* Remove leaf node
                 */
            } else {
                node.assets.splice(index, 1);
            }
        }
        cb();
        return;
    }

    if (node.leftChild != null) { // Try to insert into existing left child
        insertAsset(node.leftChild, asset, axis, recursionDepth, cb);
        return;
    }

    if (node.rightChild != null) { // Try to insert into existing right child
        insertAsset(node.rightChild, asset, axis, recursionDepth, cb);
        return;
    }

    var leftBoundary = halfBoundary(node.boundary, axis, -1);
    switch (intersectsBoundary(leftBoundary, asset.boundary)) {
        case INTERSECT_INSIDE: // Inside left boundary - insert into left child
            if (!node.leftChild) {
                node.leftChild = {
                    id:  "map-" + uuid.uuidFast(),
                    boundary: leftBoundary,
                    assets: []
                };
            }
            insertAsset(node.leftChild, asset, axis, recursionDepth, cb);
            return;

        case INTERSECT_PARTIAL: // Overlaps left and right child boundaries - insert into this node
            node.assets.push(asset);
            cb();
            return;

        case INTERSECT_OUTSIDE: // Outside left boundary - insert into right child
            var rightBoundary = halfBoundary(node.boundary, axis, 1);
            if (!node.rightChild) {
                node.rightChild = {
                    id:  "map-" + uuid.uuidFast(),
                    boundary: rightBoundary,
                    assets: []
                };
            }
            insertAsset(node.rightChild, asset, axis, recursionDepth, cb);
            return;
    }
}

function getAssetIndex(node, asset) {
    for (var i = 0; i < node.assets.length; i++) {
        if (node.assets[i] == asset.assetId) {
            return i;
        }
    }
    return -1;
}