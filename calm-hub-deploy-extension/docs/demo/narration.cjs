// The demo's voiceover, as data. record-hub-demo.cjs speaks each beat (voice.cjs) and shows the same words as the
// caption; `term` is the short comment typed in the terminal for that beat (so the left pane reads on its own).
// Keep spoken text free of what a voice mangles (file names, dotted paths, tool names): put those in `term`, and
// respell words the voice gets wrong in pronunciation.cjs.
//
// ctx: { name, running, storage, choice, valid, invalid, card } worked out from what runs (see record-hub-demo.cjs);
// card is the home page card's counts: { services, inSync, drifted }.
const short = choice => (choice.startsWith('SQLite') ? 'SQLite on its own volume' : 'PostgreSQL');
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = n => WORDS[n] ?? String(n);
/** The card's counts, as spoken: "one service, one in sync, none drifted". */
const cardText = ({ services, inSync, drifted }) =>
  `${count(services)} service${services === 1 ? '' : 's'}, ${inSync === 0 ? 'none' : count(inSync)} in sync, ${drifted === 0 ? 'none' : count(drifted)} drifted`;

module.exports = function narration(ctx) {
  const { name, running, storage, choice, valid, invalid, card } = ctx;
  const toSqlite = choice.startsWith('SQLite');
  const beats = [
    // ---- 1. CALM Hub today
    {
      id: 'hub-home',
      text: 'This is CALM Hub, the FINOS architecture-as-code repository, as it ships. Its home page lists the namespaces that hold architectures and patterns, and the control domains that hold controls. There is no Extensions section: nothing is plugged in.',
    },
    {
      id: 'namespace',
      text: 'The hackathon namespace holds the architectures a developer portal created, and the patterns it created them from.',
    },
    {
      id: 'pattern',
      text: 'A pattern is a template for architectures. This one is an event-streaming service: a web client, an API gateway, a stream app, and a Nisshi broker.',
    },
    {
      id: 'decisions',
      text: 'A pattern can leave decisions open. This one leaves one: where the broker keeps its topics, in PostgreSQL, or in SQLite on the broker’s own volume. Each architecture records its choice.',
    },
    {
      id: 'control',
      text: 'Controls live in control domains. In the hackathon security domain, Permitted Connection says that every connection must name its protocol and give a business reason.',
    },
    {
      id: 'architecture',
      text: `And this is ${name}, an architecture made from that pattern, at version ${running}. Its broker keeps its topics in ${storage}. It runs on the local Kubernetes cluster that the terminal on the left can reach.`,
    },
    {
      id: 'connection-control',
      text: 'Every connection carries that control, as security. So a change to a connection can be checked against the firm’s rules.',
    },
    {
      id: 'registry-before',
      term: 'Which extensions has CALM Hub loaded?',
      text: 'Ask CALM Hub which extensions it has loaded. Two come back, both built in, and both are only views: one for deployment records, one for control evaluations. Neither has a backend.',
    },

    // ---- 2. Deployment records are write-only
    {
      id: 'overlay',
      text: 'The deployments view draws deployment records on the diagram. Each node the last deployment covered has a badge: completed.',
    },
    {
      id: 'badge',
      text: 'A badge opens the record behind it: its status, and when it started.',
    },
    {
      id: 'view-all',
      text: 'View all opens the Decorators tab, filtered to deployments. This is the record itself: a standard CALM deployment decorator, with its status, its times and its notes.',
    },
    {
      id: 'any-tool',
      text: 'Because the record is a standard, any tool can write one, and CALM Hub will draw it: a pipeline, a script, or a person.',
    },
    {
      id: 'write-only',
      text: 'But these records are write-only. CALM Hub draws what it is told, and cannot tell whether a record is still true. It cannot start a deployment, or stop one that would break a control.',
    },

    // ---- 3. A Platform Connector
    {
      id: 'connector',
      text: 'That is what a Platform Connector adds. It is a CALM Hub extension that a firm writes to connect its own delivery platform. This one is the reference connector for GitOps on Kubernetes: Git, a pull request, and Flux.',
    },
    {
      id: 'manifest',
      term: 'The manifest: one JSON file',
      text: 'An extension is a manifest and a backend. The manifest is one JSON file that tells CALM Hub what the connector offers.',
    },
    {
      id: 'routes',
      term: 'Routes: method, scope, path on the backend',
      text: 'Routes are paths on the connector’s backend, each with the scope a caller needs. CALM Hub checks that scope before it passes a call on: read for the views, write to deploy.',
    },
    {
      id: 'contributes',
      term: 'Contributions: where it shows in CALM Hub',
      text: 'Contributions say where it appears in CALM Hub’s own screens: an action on an architecture, a tab, a panel in the node sidebar, a card on the home page, and a screen of its own.',
    },
    {
      id: 'commands',
      term: 'Commands: the same routes, with schemas',
      text: 'Commands are routes with input and output schemas. CALM Hub turns each one into a command line command, and into a tool that agents can call.',
    },
    {
      id: 'start-backend',
      term: 'Start the backend: changes need approval',
      text: 'Start the backend. Approval is manual, so a person has to approve each change before it reaches the cluster.',
    },
    {
      id: 'restart',
      term: 'Restart CALM Hub with the manifest',
      text: 'Now restart CALM Hub with the manifest in place.',
    },
    {
      id: 'signed',
      text: 'CALM Hub signs every call it passes on. The signature names the caller, the route, the scope CALM Hub checked, and an audit id. The connector refuses any call that CALM Hub did not sign.',
    },
    {
      id: 'registry-after',
      term: 'Loaded: platform-connector',
      text: 'CALM Hub now lists platform-connector, next to its built-in views.',
    },
    {
      id: 'mcp-tools',
      term: 'The commands are MCP tools already',
      text: 'And its commands are already tools on CALM Hub’s MCP server, for agents: status, history and deploy.',
    },

    // ---- 4. Woven in
    {
      id: 'home-card',
      text: `Back on the home page, there is now an Extensions section with the connector’s card: ${cardText(card)}.`,
    },
    {
      id: 'blocks',
      text: 'The connector sends no HTML. It answers with blocks, a list of fields, an alert or a table, and CALM Hub draws them in its own style.',
    },
    {
      id: 'ext-tab',
      text: 'On the architecture there is now an Extensions tab, with the Deploy this version action and the connector’s Deployment tab.',
    },
    {
      id: 'tab-facts',
      text: 'The tab holds only what the platform knows: the version running, Flux’s status, the commit it applied, and whether CALM Hub’s newest record matches. History stays in CALM Hub’s own deployments view.',
    },
    {
      id: 'node-panel',
      text: 'Select a node. The node sidebar now has an Extensions section, with the connector’s Platform panel.',
    },
    {
      id: 'node-facts',
      text: 'For the stream app, it shows the workload that runs it, the replicas ready against the replicas Git asks for, its image, the network policies that let traffic in and out, and the deployment record that covers it.',
    },
    {
      id: 'log-calls',
      term: 'The calls CALM Hub made to the connector',
      text: 'The connector’s log shows each call CALM Hub made for these views: the card, the tab and the node panel. Each one was signed by CALM Hub, with the scope it checked and the caller.',
    },

    // ---- 5. Drift: what a record can't know
    {
      id: 'scale',
      term: 'Change the cluster behind Git’s back',
      text: 'Now change the cluster behind Git’s back. Scale the stream app to zero.',
    },
    {
      id: 'drift-panel',
      text: 'Select the stream app again. The panel shows drift: it runs zero replicas, and Git asks for one.',
    },
    { id: 'drift-tab', text: 'The Deployment tab leads with the same drift.' },
    {
      id: 'badge-stale',
      text: 'But on the diagram, the deployment badge still says completed. The record cannot know. It says what happened, not what is true now.',
    },
    {
      id: 'reconcile',
      term: 'Ask Flux to put it back now',
      text: 'Flux would put the replicas back at its next reconcile, within a minute. Ask it to reconcile now, and wait for the stream app.',
    },
    {
      id: 'in-sync',
      text: 'Select it again: in sync. Only the platform can say whether a record is still true, and the connector is how CALM Hub asks it.',
    },

    // ---- 6. A decision changes, and the connector deploys it
    {
      id: 'new-version',
      term: `A new version: broker storage = ${short(choice)}`,
      text: `An architect changes the pattern decision. In a new version, ${valid}, the broker keeps its topics in ${short(choice)}. The script generates it from the pattern, validates it, and stores it in CALM Hub.`,
    },
    {
      id: 'diagram-new',
      text: `Here is ${valid}. ${toSqlite ? 'The PostgreSQL node and its connection are gone: the broker keeps its topics itself.' : 'A PostgreSQL node and its connection are back: the broker keeps its topics there.'}`,
    },
    {
      id: 'warning',
      text: `The Deployment tab compares the version on screen with the one running, and warns that the cluster still runs ${running}.`,
    },
    {
      id: 'click',
      text: 'Choose Deploy this version. It changes something, so CALM Hub asks first, and checks that the caller can write to the namespace.',
    },
    {
      id: 'run',
      term: `Follow the deployment of ${valid}`,
      text: 'Run. First the connector checks the version against its pattern and against the controls in CALM Hub. That is the controls gate.',
    },
    {
      id: 'record-pending',
      text: `${valid} passes, so the connector writes a standard deployment record on it, pending. That is the record on the right, in CALM Hub’s Decorators tab.`,
    },
    {
      id: 'steps',
      text: 'Then it renders the service’s Kubernetes manifests from the new version, on a branch, and opens a pull request. Each step updates the same record.',
    },
    {
      id: 'waiting',
      text: 'Now it waits: in progress, waiting for someone to approve the pull request. In this firm, a change to a running service needs that approval.',
    },
    {
      id: 'overlay-progress',
      text: 'The built-in deployments view on the diagram follows the same record. The nodes this deployment covers show it in progress.',
    },
    {
      id: 'pr',
      term: 'The pull request the connector opened',
      text: 'This is the pull request the connector opened, in Gitea. It is an ordinary change in the service’s own repository.',
    },
    {
      id: 'files',
      term: 'What it changes',
      text: `It changes the Kubernetes manifests that Flux applies, and the architecture version in the service’s catalog file. ${toSqlite ? 'The PostgreSQL Deployment and its network policies are deleted.' : 'A PostgreSQL Deployment and its network policies are added.'}`,
    },
    {
      id: 'commit',
      term: 'Who asked, and CALM Hub’s audit id',
      text: 'The commit message says who asked, through CALM Hub, and carries the audit id of that call.',
    },
    {
      id: 'approve',
      term: 'The approver merges it',
      text: 'The firm’s own approval sits here, whatever form it takes. CALM Hub does not need to know about it. The approver merges the pull request.',
    },
    {
      id: 'flux',
      text: 'The connector sees the merge and asks Flux to reconcile, and the record says Flux is applying the merge commit.',
    },
    {
      id: 'completed',
      text: 'When Flux has applied the commit and every rollout has finished, the connector marks the record completed, with the commit and the pull request.',
    },
    {
      id: 'overlay-after',
      text: `On the diagram, each node now shows ${valid}, completed.`,
    },
    {
      id: 'standard-record',
      term: 'The record: the Kubernetes deployment standard',
      text: 'The record follows the Kubernetes deployment standard: the cluster and the namespace. The connector adds its GitOps details: the repository, the pull request, the commit, who asked, and CALM Hub’s audit id.',
    },
    {
      id: 'audit',
      term: 'CALM Hub’s audit log: the same id',
      text: 'CALM Hub’s own audit log has the call, with the same audit id. So the change traces from Git back to CALM Hub.',
    },
    {
      id: 'validated',
      term: 'CALM Hub validates it: a copy without its namespace',
      text: 'And CALM Hub validates the record. Post a copy without its Kubernetes namespace, and CALM Hub refuses it: it does not match its schema.',
    },
    {
      id: 'sub-standard',
      term: 'The GitOps details, as a standard in CALM Hub',
      text: 'The GitOps details are written up as a sub-standard, published in CALM Hub’s Standards, so other tools know how to read them.',
    },

    // ---- 7. The controls gate, as a control evaluation
    {
      id: 'forbidden',
      term: 'A version the pattern does not allow',
      text: `Now a version the pattern does not allow. In ${invalid}, the browser connects to the stream app directly, past the gateway. CALM Hub stores any valid CALM document, so it accepts it.`,
    },
    { id: 'deploy-invalid', text: `Deploy ${invalid}, the same way.` },
    {
      id: 'refused',
      term: `Follow the deployment of ${invalid}`,
      text: 'The connector checks the version first, and the pattern does not allow that connection. It is refused at the controls gate.',
    },
    {
      id: 'evaluation',
      text: 'There is no deployment record. Instead, the connector records a control evaluation, and CALM Hub’s built-in view marks the connection and both its nodes: not met.',
    },
    {
      id: 'finding',
      text: 'Its details say which control was not met, and the finding: what the validation refused.',
    },
    {
      id: 'unchanged',
      term: 'No pull request, and the cluster is unchanged',
      text: `No pull request was opened, and the cluster still runs ${valid}. The rule was enforced when it mattered, not just written down.`,
    },

    // ---- 8. The same connector for an agent
    {
      id: 'mcp-status',
      term: 'The status command, as an MCP tool',
      text: 'An agent connected to CALM Hub’s MCP server calls the same connector. The status tool says the service is in sync, with no drift, and gives the workloads and CALM Hub’s newest record.',
    },
    {
      id: 'mcp-history',
      term: 'The history command: deployments and refusals',
      text: 'The history tool lists the deployments and the refusal, read back from the same standard records.',
    },
    {
      id: 'mcp-same',
      text: 'It goes through the same route, with the same scope check, signature and audit as the button in CALM Hub. The connector has no code for agents.',
    },

    // ---- 9. The pattern
    {
      id: 'recap-1',
      text: 'So, the pattern. CALM Hub’s standards keep it neutral: any tool can write a deployment record or a control evaluation, and CALM Hub draws it.',
    },
    {
      id: 'recap-2',
      text: 'A Platform Connector adds what only the platform knows: what really runs, whether it has drifted, and how to deploy, behind the firm’s own approval and CALM Hub’s controls.',
    },
    {
      id: 'recap-3',
      text: 'This one is for GitOps on Kubernetes. Another firm writes one for its own platform, against the profile that comes with this one, and CALM Hub, its command line and its agents work with it unchanged.',
    },
  ];
  const ids = new Set();
  for (const b of beats) {
    if (ids.has(b.id)) throw new Error(`duplicate beat ${b.id}`);
    ids.add(b.id);
  }
  return beats;
};
