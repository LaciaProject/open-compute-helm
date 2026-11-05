import {DurableObject} from 'cloudflare:workers';
import {Workspace} from '@cloudflare/computer';
import {authenticateAccessAssertion} from 'weft/access-assertion';

// The package and authentication implementation are resolved from the exact
// Weft checkout. This fixture tests those dependencies, not a filesystem mock.
export class ComputerProbe extends DurableObject {
  private workspace: Workspace;
  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.workspace = new Workspace({storage: state.storage, output: false});
    this.workspace.provider().mkdirSync('/workspace', {recursive: true});
  }
  async fetch(request: Request): Promise<Response> {
    const fs = this.workspace.provider();
    const path = '/workspace/probe.txt';
    if (request.method === 'POST') fs.writeFileSync(path, await request.text(), 'utf8');
    return Response.json({value: fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null});
  }
}

export default {
  async fetch(request: Request, env: {FILES: DurableObjectNamespace}): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/auth') {
      const identity = await authenticateAccessAssertion(request, 'weft-test-audience', 'test.cloudflareaccess.com');
      return new Response(identity ? 'authenticated' : 'unauthorized', {status: identity ? 200 : 401});
    }
    const owner = url.pathname.slice(1);
    if (!['alpha', 'beta'].includes(owner)) return new Response('Not found', {status: 404});
    return env.FILES.getByName(owner).fetch(request);
  },
};
