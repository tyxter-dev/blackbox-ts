import { EnvironmentWorker, InMemoryWorkSource } from 'blackbox-ts/workers';

const source = new InMemoryWorkSource([{ id: 'one', payload: 'task' }]);
const worker = new EnvironmentWorker(source, (item) => ({ handled: item.payload }));
console.log(await worker.drain());
