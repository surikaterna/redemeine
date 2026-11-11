// Process tests fail immediately if a supposedly offline path attempts network I/O.
const deny = () => { process.stderr.write('network_attempt_refused\n'); process.exit(92); };
require('node:net').Socket.prototype.connect = deny;
require('node:net').Server.prototype.listen = deny;
require('node:tls').connect = deny;
require('node:dgram').Socket.prototype.send = deny;
require('node:dns').lookup = deny;
require('node:dns').resolve = deny;
require('node:module').syncBuiltinESMExports();
