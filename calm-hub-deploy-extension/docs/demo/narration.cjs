// The demo's voiceover, as data. record-hub-demo.cjs speaks each beat with macOS `say` and shows the same words as
// the caption; `term` is the short comment typed in the terminal for that beat (so the left pane reads on its own).
//
// ctx: { name, running, storage, choice, valid, invalid } worked out from what runs (see record-hub-demo.cjs).
const short = choice => (choice.startsWith('SQLite') ? 'SQLite on its own volume' : 'PostgreSQL');

module.exports = function narration(ctx) {
  const { name, running, storage, choice, valid, invalid } = ctx;
  const toSqlite = choice.startsWith('SQLite');
  const beats = [
    // ---- 1. CALM Hub on its own
    {
      id: 'intro',
      text: `This is CALM Hub, the FINOS architecture-as-code repository. On the right is an architecture: ${name}, an event-streaming service created from a CALM pattern. On the left is a terminal on the local Kubernetes cluster where that service runs.`,
    },
    {
      id: 'tabs',
      text: 'Look at the tabs across the top: Diagram, JSON and Decorators. This is CALM Hub as it ships, with no extensions installed, so there is no Extensions tab.',
    },
    {
      id: 'registry-before',
      term: 'Which extensions has CALM Hub loaded?',
      text: 'Ask CALM Hub which extensions it has loaded. Two built-in ones come back, and both are only views: one for deployments, one for control evaluations. Neither has a backend.',
    },
    {
      id: 'decorators',
      text: 'Those views draw decorators. Decorators are the simplest way to integrate with CALM Hub: any tool with write access can attach a fact to an architecture version. These are deployments that were recorded when this service was deployed.',
    },
    {
      id: 'overlay-before',
      text: 'The built-in Deployments view draws the same records on the diagram, node by node. But all of this is read-only. CALM Hub can show a deployment. It cannot start one.',
    },

    // ---- 2. An extension is a manifest and a backend
    {
      id: 'ext-intro',
      text: 'An extension changes that. It has two parts. A manifest tells CALM Hub what the extension offers, and a backend does the work. The backend belongs to whoever owns the tool, and runs anywhere CALM Hub can reach. This one deploys through Git and Flux, the way the firm in this example already deploys.',
    },
    {
      id: 'manifest-id',
      term: 'The manifest: one JSON file',
      text: 'The manifest is one JSON file. It names the extension, platform-connector, and the version of CALM Hub’s extension API it was written for.',
    },
    {
      id: 'routes-a',
      term: 'Routes: method, scope, path on the backend',
      text: 'Routes come first. Each route is a method and a path on the backend, with the scope a caller needs. CALM Hub serves every route under its own API, at slash api, slash calm, slash extensions, slash platform-connector.',
    },
    {
      id: 'routes-b',
      text: 'Before a call reaches the backend, CALM Hub checks that the caller has that scope on the namespace in the path. Read for the tab, the status and the history. Write for a deployment.',
    },
    {
      id: 'contributes',
      term: 'Contributions: where it shows in CALM Hub',
      text: 'Contributions say where the extension appears in CALM Hub’s own screens. This one adds a tab called Deployment to an architecture, and an action called Deploy this version. Both point at routes.',
    },
    {
      id: 'commands',
      term: 'Commands: the same routes, with schemas',
      text: 'Commands are routes with input and output schemas. CALM Hub turns each one into a command line command, and into a tool that agents can call over MCP.',
    },

    // ---- 3. Plugging it in
    {
      id: 'config',
      term: 'Installing it: configuration on the CALM Hub side',
      text: 'Installing the extension is configuration on the CALM Hub side. The manifest folder is mounted into CALM Hub. The backend URL says where the extension runs. And a signing key lets CALM Hub vouch for every call it passes on.',
    },
    {
      id: 'start-backend',
      term: 'Start the backend: changes need approval',
      text: 'Start the backend. It is a small Node service. Approval is set to manual, so a person has to approve each change before it reaches the cluster.',
    },
    {
      id: 'restart',
      term: 'Restart CALM Hub with the manifest',
      text: 'Now restart CALM Hub with the manifest in place.',
    },
    {
      id: 'identity',
      text: 'Every call CALM Hub passes on carries a signed assertion. It names the caller, the route, and the namespace whose scope CALM Hub checked. It covers the method, the path and a hash of the body, and it carries an audit id. It is short-lived, and it can be used only once.',
    },
    {
      id: 'registry-after',
      term: 'Loaded: platform-connector',
      text: 'CALM Hub now lists platform-connector, next to its built-in views.',
    },
    {
      id: 'jwks',
      term: 'CALM Hub’s public signing key',
      text: 'The backend checks each assertion against CALM Hub’s public key, which CALM Hub publishes here. A call without a valid assertion from CALM Hub is refused.',
    },
    {
      id: 'mcp-tools',
      term: 'The commands are MCP tools already',
      text: 'And the three commands are already tools on CALM Hub’s MCP server: deploy, history and status.',
    },

    // ---- 4. The Hub hooks in
    { id: 'reload', text: 'Reload the architecture. There is now an Extensions tab.' },
    {
      id: 'ext-tab',
      text: 'Inside it are the extension’s Deployment tab and its Deploy this version action. To draw this tab, CALM Hub called the extension’s tab route.',
    },
    {
      id: 'log-tab',
      term: 'The backend’s log: the call CALM Hub just made',
      text: 'The backend’s log shows that call: a GET on the tab route, verified as coming from CALM Hub, with the scope, the namespace, the caller and the audit id. This CALM Hub runs without sign-in, so the caller is no-auth. With sign-in turned on, it is the person at the screen.',
    },
    {
      id: 'blocks',
      text: 'The extension sends no HTML. It answers with blocks: a list of fields, an alert and a table. CALM Hub draws them in its own style, so the extension has no front-end code at all.',
    },
    {
      id: 'fields',
      text: 'The tab says where this version runs: the local environment, the deployment rules it was rendered with, the Git repository that Flux watches, Flux’s status, and the commit Flux applied. And it says this version is the one deployed.',
    },

    // ---- 5. Where the service runs
    {
      id: 'deploys',
      term: `The cluster runs ${running}: topics in ${storage}`,
      text: `In the cluster, ${name} runs version ${running}. Its broker keeps its topics in ${storage === 'PostgreSQL' ? 'PostgreSQL, so a PostgreSQL Deployment runs next to the broker, the stream app and the gateway' : 'SQLite on its own volume, so there is no database Deployment'}.`,
    },
    {
      id: 'status',
      term: 'The status command, through CALM Hub',
      text: 'Scripts get the same facts through CALM Hub. This is the status command, called through CALM Hub’s proxy: the version deployed, the newest version, the deployment rules, and whether Flux is ready.',
    },

    // ---- 6. An architect changes a pattern decision
    {
      id: 'pattern',
      text: `The pattern ${name} was made from leaves a few decisions open. One is where the broker keeps its topics: in PostgreSQL, or in SQLite on the broker’s own volume.`,
    },
    {
      id: 'new-version',
      term: `A new version: broker storage = ${short(choice)}`,
      text: `An architect stores a new version, ${valid}, that changes that one decision to ${short(choice)}. The script generates the architecture from the pattern, validates it, and posts it to CALM Hub.`,
    },
    {
      id: 'diagram-new',
      text: `Here is ${valid} in CALM Hub. ${toSqlite ? 'The PostgreSQL node and its connection are gone: the broker keeps its topics itself.' : 'A PostgreSQL node and its connection are back: the broker keeps its topics there.'}`,
    },
    {
      id: 'warning',
      text: `The Deployment tab compares the version on screen with the version running, and warns that the cluster still runs ${running}.`,
    },

    // ---- 7. Asking CALM Hub to deploy
    {
      id: 'click',
      text: 'Choose Deploy this version. The action changes something, so CALM Hub asks first.',
    },
    {
      id: 'dialog',
      text: 'When it runs, CALM Hub checks that the caller can write to the hackathon namespace, writes an audit entry, signs the request, and passes it on. CALM Hub gives the backend ten seconds to answer, so the backend replies at once and does the work in the background.',
    },
    {
      id: 'run',
      term: `Follow the deployment of ${valid}`,
      text: `Run. The backend records a deployment decorator on version ${valid}, with the status pending, and starts the job. On the right is that record, on CALM Hub’s Decorators tab.`,
    },
    {
      id: 'step-validate',
      text: 'First it validates the version against its pattern and against the controls in CALM Hub, with calm validate. This is the controls gate: a version that fails stops here.',
    },
    {
      id: 'step-render',
      text: `Then it renders the service’s deployment rules, the k8s-deploy bundle, against version ${valid} on a new branch, and commits the result.`,
    },
    {
      id: 'step-pr',
      text: 'It pushes the branch and opens a pull request in Gitea. Each step updates the decorator, so CALM Hub always shows where the deployment has got to.',
    },
    {
      id: 'waiting',
      text: 'Now it waits. The record says so: in progress, waiting for someone to approve the pull request. In this firm, a change to a running service needs that approval.',
    },
    {
      id: 'log-steps',
      term: 'The trail in the backend’s log',
      text: 'On the diagram, the nodes this deployment touches are marked in progress. And the backend’s log has the whole trail: the POST from CALM Hub, with write scope and its audit id, then each step recorded on the decorator.',
    },

    // ---- 8. The firm's change gate
    {
      id: 'pr',
      term: 'The pull request the extension opened',
      text: 'This is the pull request the extension opened, in Gitea on the right. It is an ordinary change, in the service’s own repository.',
    },
    {
      id: 'files',
      term: 'What it changes',
      text: `It changes the Kubernetes manifests that Flux applies, and the architecture version recorded in the service’s catalog file. ${toSqlite ? 'The PostgreSQL Deployment and its network policies are deleted, because the new architecture has no PostgreSQL node.' : 'A PostgreSQL Deployment and its network policies are added, because the new architecture has a PostgreSQL node.'}`,
    },
    {
      id: 'commit',
      term: 'Who asked, and CALM Hub’s audit id',
      text: 'The commit message says who asked, through CALM Hub, and carries the audit id of that call. So the change can be traced from Git back to CALM Hub’s audit log.',
    },
    {
      id: 'gate',
      text: 'This is where a firm’s own approvals sit: code owners, a change ticket, or a release manager. CALM Hub does not need to know about any of them. It sees the deployment wait, then carry on.',
    },
    { id: 'approve', term: 'The approver merges it', text: 'The approver merges the pull request.' },

    // ---- 9. Flux applies it
    {
      id: 'flux',
      text: 'The pull request is merged. The extension sees the merge and asks Flux to reconcile, and the record in CALM Hub says Flux is applying the merge commit.',
    },
    {
      id: 'policies',
      text: `${toSqlite ? 'The PostgreSQL Deployment goes, and so do its two network policies.' : 'A PostgreSQL Deployment starts, with its two network policies.'} The network policies are made from the architecture’s connections, so they follow the architecture.`,
    },
    {
      id: 'rollouts',
      text: 'When Flux has applied the commit and every rollout has finished, the extension marks the deployment completed, with the commit and the pull request.',
    },
    {
      id: 'overlay-after',
      text: `On the diagram, CALM Hub re-reads decorators every five seconds, so the Deployments overlay followed every step. Each node now shows version ${valid} completed.`,
    },

    // ---- 10. The results back in CALM Hub
    {
      id: 'decorators-after',
      text: 'This is the other half of the integration. The extension writes its results back through CALM Hub’s decorator API, the same way any other tool would.',
    },
    {
      id: 'record',
      text: 'The record has the status and the times, the environment, the architecture version, who asked, the extension that did the work, the commit, and CALM Hub’s audit id for the call.',
    },
    { id: 'deployed', text: `The Deployment tab now says that ${valid} is the version deployed.` },
    {
      id: 'history',
      text: 'Below it is every deployment of this architecture, whichever tool started it.',
    },
    {
      id: 'audit',
      term: 'CALM Hub’s audit log: the same id',
      text: 'And CALM Hub’s own audit log has the call, with the same audit id as the decorator and the commit.',
    },
    {
      id: 'two-ways',
      text: 'So the integration runs both ways. CALM Hub calls out to the extension through its proxy, with the caller’s scope checked and the call signed. The extension calls back in through the decorator API, and CALM Hub shows the result in its own views.',
    },

    // ---- 11. The controls gate
    {
      id: 'forbidden',
      term: 'A version the pattern does not allow',
      text: `Now a version the pattern does not allow. In ${invalid}, the browser connects to the stream app directly, past the gateway. CALM Hub stores any valid CALM document, so it accepts it.`,
    },
    { id: 'deploy-invalid', text: `Deploy ${invalid}.` },
    {
      id: 'failed',
      text: 'Validation against the pattern fails, so the extension records the deployment as failed, with the reason.',
    },
    {
      id: 'unchanged',
      term: 'No pull request, and the cluster is unchanged',
      text: `No pull request was opened, and the cluster still runs ${valid}. The pattern’s rule was enforced when it mattered, not just written down.`,
    },
    { id: 'failed-record', text: 'CALM Hub shows the failed attempt with the others, and says why it failed.' },

    // ---- 12. The same extension for an agent
    {
      id: 'mcp',
      term: 'The history command, as an MCP tool',
      text: 'An agent connected to CALM Hub’s MCP server can call the same commands. This is the history tool.',
    },
    {
      id: 'mcp-same',
      text: 'It goes through the same route, with the same scope check, signed identity and audit as the button in CALM Hub. The extension has no code for MCP.',
    },

    // ---- 13. The integration pattern
    {
      id: 'recap-1',
      text: 'So that is how a tool plugs into CALM Hub. A manifest declares routes, scopes, screens and commands. CALM Hub proxies each call, checks the caller’s scope, audits the call and signs it.',
    },
    {
      id: 'recap-2',
      text: 'The tool answers with blocks that CALM Hub knows how to draw, and records what happened as decorators on the architecture.',
    },
    {
      id: 'recap-3',
      text: 'This extension deploys with Gitea and Flux. A firm with a different deployment platform can implement the same commands and the same decorator fields, written up in the extension’s profile, and CALM Hub, its command line and its agents work with it unchanged.',
    },
  ];
  const ids = new Set();
  for (const b of beats) {
    if (ids.has(b.id)) throw new Error(`duplicate beat ${b.id}`);
    ids.add(b.id);
  }
  return beats;
};
