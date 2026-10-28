import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';

const server = createServer({ cert: readFileSync(process.argv[2]), key: readFileSync(process.argv[3]) }, (request, response) => {
	console.log(JSON.stringify({ host: request.headers.host, servername: request.socket.servername }));
	request.resume();
	response.end('accepted');
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
process.stdin.once('data', () => {
	server.closeAllConnections();
	server.close(() => process.exit(0));
});
