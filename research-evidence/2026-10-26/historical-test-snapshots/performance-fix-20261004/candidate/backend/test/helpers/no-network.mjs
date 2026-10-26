// Loaded only by test:business. Keep this suite within service/store calls,
// even if a future test accidentally imports an HTTP or Socket test harness.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

function blocked(operation) {
  return function networkDisabled() {
    throw new Error(`BUSINESS_TEST_NETWORK_DISABLED: ${operation}`);
  };
}

net.Server.prototype.listen = blocked("server.listen");
net.Socket.prototype.connect = blocked("socket.connect");
net.connect = blocked("net.connect");
net.createConnection = blocked("net.createConnection");
tls.connect = blocked("tls.connect");
http.request = blocked("http.request");
http.get = blocked("http.get");
https.request = blocked("https.request");
https.get = blocked("https.get");
dgram.createSocket = blocked("dgram.createSocket");
globalThis.fetch = blocked("fetch");
if ("WebSocket" in globalThis) globalThis.WebSocket = blocked("WebSocket");
syncBuiltinESMExports();
