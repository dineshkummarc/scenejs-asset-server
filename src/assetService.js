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
var log = require('../lib/log').log;
var ws = require('../lib/ws');
var url = require('url');
var qs = require('querystring');

var assetStore = require('./assets/assetStore');

var settings;
var server;


exports.defaultSettings = {
    host : "localhost",
    port : 8888,
    attachmentsDir : process.cwd() + "/.attachments",
    db : {
        host: "localhost",
        port: 5984,
        dbname: "scenejs-assets"
    }
};

exports.start = function(customSettings, cb) {
    settings = customSettings || {};
    settings.__proto__ = exports.defaultSettings;

    assetStore.start(settings);

    createDummyContent();

    server = ws.createServer({
        debug: false
    });

    server.addListener("listening", function() {
        log("SceneJS Asset Server listening for connections on " + settings.host + ":" + settings.port);
        if (cb) {
            cb();
        }
    });

    /*---------------------------------------------------
     * Handle WebSocket requests
     *--------------------------------------------------*/

    server.addListener("connection",
            function(conn) {


                log("opened connection: " + conn._id);

                conn.addListener("message",
                        function(message) {
                            parseMessage(message,
                                    function(params) {

                                        service(
                                                params,
                                                function (result) {
                                                    if (result.error) {
                                                        server.send(conn._id, JSON.stringify(result));
                                                    } else {
                                                        var jsonStr = JSON.stringify(result);
                                                        server.send(conn._id, jsonStr);
                                                    }
                                                });
                                    },
                                    function(error) {
                                        // log("<" + conn._id + "> ERROR handling request: " + error.error + " : " + error.message);
                                        server.send(JSON.stringify(error));
                                    });
                        });
            });


    server.addListener("close", function(conn) {
        log("closed connection: " + conn._id);
    });

    /*---------------------------------------------------
     * Handle HTTP requests
     *--------------------------------------------------*/

    server.addListener("request",
            function(req, res) {
                res.writeHead(200, {'Content-Type': "text/plain"});
                var params = qs.parse(url.parse(req.url).query);
                log("http request " + JSON.stringify(params));

                service(
                        params,
                        function (result) {
                            if (result.error) {
                                log("error handling HTTP request: " + result.error + " : " + result.body);
                                res.end(JSON.stringify(result));

                            } else {

                                var resultStr;
                                switch (result.format) {

                                    /* Naked unbodied response from asset store,
                                     * eh. script for <script> tag or SceneJS.requireModule
                                     */
                                    case "script" :
                                        resultStr = result.body;
                                        break;

                                    default:

                                        /* Bodied response from asset store
                                         */
                                        resultStr = JSON.stringify(result);
                                }

                                log("responding with " + resultStr.length + " chars");
                                res.end(resultStr);

                            }
                        });
                log("DONE http request");
            });

    server.addListener("shutdown", function(conn) {
        log("Server shutdown"); // never actually happens, because I never tell the server to shutdown.
    });

    server.listen(settings.port, settings.host);
};

function parseMessage(message, ok, er) {
    try {
        ok(JSON.parse(message));
    } catch (e) {
        er({ error : 501, body : "request is not valid JSON: " + message });
    }
}

function service(params, callback) {
    if (!params.cmd) {
        callback({
            error: 501,
            body: "I need a cmd!"
        });
    } else {
        var fn = assetStore[params.cmd];
        if (!fn) {
            callback({
                error: 501,
                body: "I don't know that cmd: '" + params.cmd + "'"
            });
        } else {
            fn(params, callback);
        }
    }
}


function createDummyContent() {
    for (var i = 0; i < 10; i++) {
        assetStore.createAsset({
            meta : {
                name :"plane",
                description: "This is my elephant!",
                tags : ["rabbits"]
            },
            assembly : {
                type : "dae",
                source: {
                    url: "http://www.scenejs.org/library/v0.7/assets/examples/seymourplane_triangulate/seymourplane_triangulate_augmented.dae"
                    //    url: "http://scenejs.org/library/v0.7/assets/examples/courtyard-house/models/model.dae"
                }
            }},
                function(result) {
                    if (result.error) {
                        sys.puts("" + result.error + ": " + result.body);
                    } else {
                        sys.puts("CREATED OK");
                        //                    assetStore.getAsset({ cmd: "getAsset",
                        //                        assetId : "org.scenejs.examples.v0_7_6.seymour_plane_A"+i
                        //                    },
                        //                            function(result) {
                        //                                sys.puts("" + result.error + ": " + result.body);
                        //                            });
                    }
                });
    }
}