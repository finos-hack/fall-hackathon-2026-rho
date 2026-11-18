"""CALM Ripples: directed reachability over explicitly modeled connects relationships."""
from collections import deque


def analyze(document, origin):
    nodes = document.get('nodes', [])
    if not isinstance(nodes, list) or not isinstance(document.get('relationships', []), list):
        raise ValueError('nodes and relationships must be arrays')
    by_id = {}
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get('unique-id'), str) or not node['unique-id'] or node['unique-id'] in by_id:
            raise ValueError('nodes need distinct unique-id values')
        by_id[node['unique-id']] = node
    if origin not in by_id:
        raise ValueError('selected origin is not in the architecture')
    links, skipped = [], 0
    for relationship in document.get('relationships', []):
        if not isinstance(relationship, dict):
            skipped += 1
            continue
        kind = relationship.get('relationship-type') or {}
        connection = kind.get('connects') if isinstance(kind, dict) else None
        if not isinstance(connection, dict):
            skipped += 1
            continue
        source = connection.get('source') or {}
        target = connection.get('destination') or {}
        source = source.get('node') if isinstance(source, dict) else None
        target = target.get('node') if isinstance(target, dict) else None
        if source not in by_id or target not in by_id:
            skipped += 1
            continue
        links.append((source, target, relationship))
    adjacency = {node: [] for node in by_id}
    for source, target, relation in links:
        adjacency[source].append(target)
    distances = {origin: 0}
    queue = deque([origin])
    while queue:
        current = queue.popleft()
        for target in adjacency[current]:
            if target not in distances:
                distances[target] = distances[current] + 1
                queue.append(target)
    return by_id, links, distances, skipped


DEMO_CONTROL_BASE = 'https://example.org/calm-ripples-demo/controls/'


def declared(element, control):
    """Match a specific illustrative requirement reference, never descriptions or protocol names."""
    controls = element.get('controls', {})
    if not isinstance(controls, dict):
        return False
    for group in controls.values():
        if isinstance(group, dict):
            requirements = group.get('requirements', [])
            if isinstance(requirements, list):
                for item in requirements:
                    if isinstance(item, dict) and item.get('requirement-url') == DEMO_CONTROL_BASE + control:
                        return True
    return False


def demo_controls(by_id, links, distances, classifications):
    findings = []
    for source, target, relationship in links:
        if source in distances and target in distances and not declared(relationship, 'encryption-in-transit'):
            a = by_id[source].get('name') or source
            b = by_id[target].get('name') or target
            findings.append([f'{a} → {b}', 'Encryption in transit', 'Not declared', 'Investigate transport protection; it may reduce interception or tampering.'])
    for node_id in distances:
        if node_id not in classifications:
            continue
        node = by_id[node_id]
        name = node.get('name') or node_id
        if not declared(node, 'encryption-at-rest'):
            findings.append([name, 'Encryption at rest', 'Not declared', 'Investigate stored-data protection; it may reduce exposure of stored data.'])
        if not declared(node, 'audit-logging'):
            findings.append([name, 'Audit logging', 'Not declared', 'Investigate audit coverage to help detect and reconstruct activity.'])
    return findings


def lens(document, origin=None, view="ripple", depth="2"):
    nodes = document.get('nodes', [])
    if not nodes:
        raise ValueError('architecture has no nodes')
    if len(nodes) > 200:
        raise ValueError('prototype supports up to 200 nodes')
    origin = origin or nodes[0].get('unique-id')
    by_id, links, distances, skipped = analyze(document, origin)
    if len(links) > 2000:
        raise ValueError('prototype supports up to 2,000 modeled connections')
    if view not in ('ripple', 'all'):
        raise ValueError('unknown view')
    if depth not in ('1', '2', '3', 'all'):
        raise ValueError('unknown hop limit')
    # Include direct incoming neighbors for navigation, without counting them as reached.
    upstream = {a for a, b, _ in links if b == origin and a not in distances}
    visible_reached = {node_id for node_id, distance in distances.items() if depth == 'all' or distance <= int(depth)}
    visible = (visible_reached | upstream) if view == 'ripple' else set(by_id)
    metadata = document.get('metadata', {})
    demo = metadata.get('calm-ripples-demo', {}) if isinstance(metadata, dict) else {}
    demo = demo if isinstance(demo, dict) else {}
    classifications = demo.get('classifications', {})
    classifications = classifications if isinstance(classifications, dict) else {}
    control_demo = demo.get('enable-control-demo') is True
    graph_nodes = []
    for node_id, node in by_id.items():
        if node_id not in visible:
            continue
        tag = 'origin' if node_id == origin else 'reached' if node_id in distances else 'upstream' if node_id in upstream else 'other'
        label = str(node.get('name') or node_id)[:200]
        item = {'id': node_id, 'label': label, 'metadata': str(node.get('node-type') or 'component').upper()[:80], 'tags': [tag]}
        # Hub navigates within this lens when a node supplies view parameters.
        if len(node_id) <= 128 and not any(ord(c) < 32 or ord(c) == 127 for c in node_id):
            item['link'] = {'params': {'origin': node_id}}
        if node_id in distances and node_id != origin:
            item['badges'] = [{'text': str(distances[node_id]) + (' hop' if distances[node_id] == 1 else ' hops'), 'tone': 'info'}]
        if node_id in classifications:
            item.setdefault('badges', []).append({'text': str(classifications[node_id]).upper()[:40], 'tone': 'warning'})
        graph_nodes.append(item)
    graph_edges = [{'id': 'edge-' + str(i), 'source': a, 'target': b, 'tags': [('review' if control_demo and not declared(r, 'encryption-in-transit') else 'ripple') if a in distances and b in distances else 'context'], 'label': str(r.get('protocol') or '')[:200]} for i, (a, b, r) in enumerate(links) if a in visible and b in visible]
    reached = sorted(((d, by_id[n].get('name') or n, n) for n, d in distances.items() if n != origin), key=lambda x: (x[0], x[1], x[2]))
    blocks = [{'type': 'alert', 'tone': 'info', 'text': f'{len(reached)} of {len(by_id) - 1} other nodes are reachable through modeled connections. Click a component to explore its ripple.'}]
    if view == 'ripple' and len(visible_reached) < len(distances):
        blocks.append({'type': 'markdown', 'text': f'**Diagram shows {len(visible_reached)-1} of {len(distances)-1} reached components**, up to {depth} {"hop" if depth == "1" else "hops"}. Change Hops shown to see more. Counts and findings cover the full modeled ripple.'})
    if upstream:
        blocks.append({'type': 'markdown', 'text': '**Navigate:** Select an upstream component to move back along a modeled connection, or use the starting-system menu to jump anywhere.'})
    else:
        blocks.append({'type': 'markdown', 'text': '**Navigate:** Use the starting-system menu to jump to any component, or choose Full architecture to see them all.'})
    if skipped:
        blocks.append({'type': 'alert', 'tone': 'warning', 'text': f'{skipped} relationships were not traversed: they use other relationship types or have missing endpoints.'})
    sensitive = [(name, classifications[node_id], distance) for distance, name, node_id in reached if node_id in classifications]
    if sensitive:
        blocks.append({'type': 'alert', 'tone': 'warning', 'text': f'{len(sensitive)} reached nodes have fictional demo data classifications. These labels use demo metadata, not a standard CALM classification.'})
        blocks.append({'type': 'table', 'columns': ['Sensitive data store', 'Classification', 'Hops'], 'rows': [[str(name)[:200], str(level), str(distance)] for name, level, distance in sensitive]})
    findings = demo_controls(by_id, links, distances, classifications) if control_demo else None
    summary = f'**{max(distances.values())} hops**'
    if classifications:
        summary += f' · **{len(sensitive)} demo-classified stores**'
    else:
        summary += ' · **Data classification not evaluated**'
    if findings is not None:
        summary += f' · **{len(findings)} control declarations to review**'
    blocks.insert(1, {'type': 'markdown', 'text': summary})
    blocks.append({'type': 'alert', 'tone': 'info', 'text': 'Modeled reachability is a starting point for investigation, not evidence of compromise or actual access.'})
    panels = [{'title': '01  ·  Impact', 'blocks': blocks}]
    if isinstance(demo, dict) and demo.get('enable-control-demo') is True:
        control_blocks = [{'type': 'alert', 'tone': 'info', 'text': 'Illustrative demo rules inspect exact control requirement references on the reachable paths and classified stores. A missing declaration is unknown, not proof of an absent control. A declaration does not verify runtime enforcement.'}]
        if findings:
            control_blocks.insert(0, {'type': 'markdown', 'text': f'**{len(findings)} to review** · {sum(row[1] == "Encryption in transit" for row in findings)} connections · {sum(row[1] != "Encryption in transit" for row in findings)} store controls'})
            control_blocks.append({'type': 'alert', 'tone': 'warning', 'text': f'{len(findings)} control declarations to investigate. These suggestions are starting points, not incident-response instructions or guaranteed mitigations.'})
            control_blocks.append({'type': 'table', 'columns': ['Where', 'Control', 'Model', 'Why investigate'], 'rows': [[str(c)[:200] for c in row] for row in findings]})
        else:
            control_blocks.append({'type': 'alert', 'tone': 'info', 'text': 'No gaps found by these limited demo rules; other risks and controls were not evaluated.'})
        panels.append({'title': '02  ·  Controls to investigate', 'blocks': control_blocks})
    else:
        panels.append({'title': '02  ·  Controls to investigate', 'blocks': [{'type': 'alert', 'tone': 'info', 'text': 'No control rule set is configured for this architecture. These examples are prompts for investigation, not findings.'}, {'type': 'table', 'columns': ['Control to consider', 'Why'], 'rows': [['Access restrictions', 'Review which identities can reach the component.'], ['Encryption in transit', 'Review protection on relevant connections.'], ['Audit logging', 'Review whether activity can be investigated.']]}]})
    return {'hubApi': 0, 'kind': 'graph', 'title': 'CALM Ripples', 'layout': {'algorithm': 'layered', 'direction': 'right'}, 'graph': {'nodes': graph_nodes, 'edges': graph_edges}, 'controls': [{'type': 'select', 'param': 'origin', 'label': 'Starting system', 'value': origin, 'items': [{'value': node_id, 'label': str(node.get('name') or node_id)[:100]} for node_id, node in by_id.items()]}, {'type': 'segmented', 'param': 'view', 'label': 'Show', 'value': view, 'items': [{'value': 'ripple', 'label': 'Ripple'}, {'value': 'all', 'label': 'Full architecture'}]}, {'type': 'select', 'param': 'depth', 'label': 'Hops shown', 'value': depth, 'items': [{'value': '1', 'label': '1 hop'}, {'value': '2', 'label': '2 hops'}, {'value': '3', 'label': '3 hops'}, {'value': 'all', 'label': 'All hops'}]}], 'panels': panels}
