var net = require('net');
var Server = require('./server');
var JID = require('./jid');


dbgStream = function(tag, stream) {
    stream.on('data', function(data) {
	console.log(tag + ' in: ' + data);
    });
    stream.on('error', function(e) {
	console.log(tag + ' error: ' + e.stack);
    });
    stream.on('close', function() {
	console.log(tag + ' close');
    });
    var oldSend = stream.send;
    stream.send = function(data) {
	console.log(tag + ' out: ' + data);
	oldSend.call(stream, data);
    };
};

/**
 * Represents a domain we host with connections to federated services
 */
function DomainContext(domain) {
    this.domain = domain;
    this.s2sIn = {};
    this.s2sOut = {};
}

/**
 * Buffers until stream has been verified via Dialback
 */
DomainContext.prototype.send = function(stanza) {
    if (stanza.root)
	stanza = stanza.root();

    // TODO: return on empty to
    destDomain = new JID.JID(stanza.attrs.to).domain;
    var outStream = this.getOutStream(destDomain);

    if (outStream.isVerified)
	outStream.send(stanza);
    else {
	outStream.queue = outStream.queue || [];
	outStream.queue.push(stanza);
    }
};

/**
 * Does only buffer until stream is established, used for Dialback
 * communication itself.
 *
 * returns the stream
 */
DomainContext.prototype.sendRaw = function(stanza, destDomain) {
    if (stanza.root)
	stanza = stanza.root();

    var outStream = this.getOutStream(destDomain);
    var send = function() {
	outStream.send(stanza)
    };

    if (outStream.isOnline)
	send();
    else
	outStream.addListener('online', send);

    return outStream;
};

DomainContext.prototype.getOutStream = function(domain) {
    var self = this;

    // TODO: check incoming as well
    if (this.s2sOut.hasOwnProperty(domain)) {
	// There's one already
	return this.s2sOut[domain];
    } else {
	// Setup a new outgoing connection
	var outStream = this.s2sOut[domain] =
	    Server.makeOutgoingServer(domain);
	dbgStream('outgoing', outStream);
	outStream.addListener('error', function() {
	    // TODO: purge queue
	    delete self.s2sOut[domain];
	    outStream.end();
	});

	// Prepare dialback
	outStream.addListener('online', function() {
	    outStream.isOnline = true;
	    outStream.dbKey = generateKey();
	    outStream.send(Server.dialbackKey(self.domain, domain, outStream.dbKey));
	});
	outStream.addListener('dialbackResult', function(from, to, isValid) {
	    if (isValid) {
		outStream.isVerified = true;
		if (outStream.queue) {
		    outStream.queue.forEach(function(stanza) {
			outStream.send(stanza);
		    });
		    delete outStream.queue;
		}
	    } else {
		outStream.emit('error', new Error('Dialback failure'));
	    }
	});

	return outStream;
    }
};

DomainContext.prototype.verifyDialback = function(domain, id, key) {
    var outStream;
    if (this.s2sOut.hasOwnProperty(domain) &&
	(outStream = this.s2sOut[domain])) {

	var isValid = outStream.streamAttrs.id === id &&
	    outStream.dbKey === key;

	outStream.send(Server.dialbackResult(this.domain, domain, isValid));
	return isValid;
    } else
	return false;
};

/**
 * TODO:
 * * recv stanzas
 * * send on incoming? no forwarding.
 * * jid check (<improper-addressing/>)
 * * karma
 * * nameprep
 * * listening
 * * allow only to hosted domains
 * * timeouts
 * * parser errors
 * * keepAlive
 */
function Router(s2sPort) {
    var self = this;
    this.ctxs = {};

    net.createServer(function(stream) {
	self.acceptConnection(stream);
    }).listen(s2sPort || 5269);
}
exports.Router = Router;

Router.prototype.acceptConnection = function(stream) {
    var self = this;
    dbgStream('incoming', stream);

    Server.makeIncomingServer(stream);

    // incoming server wants to verify an outgoing connection of ours
    stream.addListener('dialbackVerify', function(from, to, id, key) {
	var isValid = self.verifyDialback(from, to, id, key);
	stream.send(Server.dialbackVerified(to, from, id, isValid));
    });
    // incoming server wants us to verify this connection
    stream.addListener('dialbackKey', function(from, to, key) {
	var ctx = self.getContext(to);
	var outStream = ctx.sendRaw(Server.dialbackVerify(to, from, stream.streamId, key),
				    from);

	var onVerified;
	onVerified = function(from, to, id, isValid) {
	    // TODO: what if outgoing connection is gone?
	    ctx.sendRaw(Server.dialbackResult(to, from, isValid), from);
	    outStream.removeListener('dialbackVerified', onVerified);
	};
	outStream.addListener('dialbackVerified', onVerified);
    });
};

Router.prototype.send = function(stanza) {
    if (stanza.root)
	stanza = stanza.root();

    console.log({send:stanza});
    if (stanza.attrs && stanza.attrs.from) {
	var domain = (new JID.JID(stanza.attrs.from)).domain;
	this.getContext(domain).send(stanza);
    } else
	throw 'Sending stanza without destination';
};

Router.prototype.hasContext = function(domain) {
    return this.ctxs.hasOwnProperty(domain);
};

Router.prototype.getContext = function(domain) {
    if (this.ctxs.hasOwnProperty(domain))
	return this.ctxs[domain];
    else
	return (this.ctxs[domain] = new DomainContext(domain));
};

Router.prototype.verifyDialback = function(from, to, id, key) {
    return this.hasContext(to) &&
	this.getContext(to).verifyDialback(from, id, key);
};


function generateKey() {
    var r = new Buffer(16);
    for(var i = 0; i < r.length; i++) {
	r[i] = 48 + Math.floor(Math.random() * 10);  // '0'..'9'
    }
    return r.toString();
}