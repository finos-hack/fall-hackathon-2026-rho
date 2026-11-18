import sys
import json
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ripples import analyze, lens, demo_controls, declared, DEMO_CONTROL_BASE


def edge(name, source, dest):
    return {'unique-id': name, 'relationship-type': {'connects': {'source': {'node': source}, 'destination': {'node': dest}}}}


class RipplesTest(unittest.TestCase):
    def setUp(self):
        self.doc = {'nodes': [{'unique-id': i, 'node-type': 'service', 'name': i} for i in ['rewards', 'bus', 'customer', 'warehouse', 'fx']], 'relationships': [edge('a', 'rewards', 'bus'), edge('b', 'rewards', 'customer'), edge('c', 'bus', 'warehouse'), edge('d', 'warehouse', 'rewards'), {'unique-id': 'other', 'relationship-type': {'composed-of': {'container': 'fx', 'nodes': ['customer']}}}]}

    def test_shortest_distance_cycles_and_direction(self):
        _, _, distances, skipped = analyze(self.doc, 'rewards')
        self.assertEqual(distances, {'rewards': 0, 'bus': 1, 'customer': 1, 'warehouse': 2})
        self.assertEqual(skipped, 1)
        self.assertEqual(analyze(self.doc, 'customer')[2], {'customer': 0})

    def test_lens_explains_scope(self):
        reply = lens(self.doc, 'rewards')
        self.assertEqual(reply['kind'], 'graph')
        self.assertEqual(reply['controls'][0]['value'], 'rewards')
        self.assertIn('3 of 4', reply['panels'][0]['blocks'][0]['text'])
        self.assertTrue(any('not evidence' in block.get('text', '') for block in reply['panels'][0]['blocks']))
        self.assertTrue(any(block.get('tone') == 'warning' for block in reply['panels'][0]['blocks']))

    def test_digital_bank_scenarios_and_focus(self):
        doc = json.loads((Path(__file__).resolve().parents[1] / 'examples/digital-bank.calm.json').read_text())
        self.assertEqual((len(doc['nodes']), len(doc['relationships'])), (42, 51))
        self.assertEqual(len(analyze(doc, 'rewards-service')[2]) - 1, 12)
        self.assertEqual(len(analyze(doc, 'fx-rates-service')[2]) - 1, 1)
        reply = lens(doc, 'rewards-service')
        self.assertTrue(len(reply['graph']['nodes']) < 13 + len(doc['nodes']))
        self.assertEqual(len(lens(doc, 'rewards-service', depth='all')['graph']['nodes']), 14)
        self.assertTrue(any('Diagram shows' in block.get('text', '') for block in reply['panels'][0]['blocks']))
        target = next(n for n in reply['graph']['nodes'] if n['id'] == 'event-bus')
        self.assertEqual(target['link']['params']['origin'], 'event-bus')
        self.assertNotIn('calm', target)
        self.assertNotEqual(lens(doc, 'event-bus')['panels'][1], reply['panels'][1])
        self.assertEqual(len(lens(doc, 'rewards-service', 'all')['graph']['nodes']), 42)

    def test_navigation_from_terminal_component_does_not_count_upstream_as_impact(self):
        doc = {'nodes': [{'unique-id': i, 'node-type': 'service'} for i in ['app', 'api', 'db']], 'relationships': [edge('a', 'app', 'api'), edge('b', 'api', 'db')]}
        result = lens(doc, 'db')
        upstream = next(n for n in result['graph']['nodes'] if n['id'] == 'api')
        self.assertEqual(upstream['tags'], ['upstream'])
        self.assertEqual(upstream['link']['params']['origin'], 'api')
        self.assertIn('0 of 2', result['panels'][0]['blocks'][0]['text'])
        self.assertNotIn('app', [n['id'] for n in result['graph']['nodes']])
        self.assertEqual(len(result['graph']['edges']), 1)

    def test_demo_controls_check_reachable_paths_and_explicit_references(self):
        doc = json.loads((Path(__file__).resolve().parents[1] / 'examples/digital-bank.calm.json').read_text())
        nodes, links, distances, _ = analyze(doc, 'rewards-service')
        classifications = doc['metadata']['calm-ripples-demo']['classifications']
        findings = demo_controls(nodes, links, distances, classifications)
        self.assertTrue(any(row[0] == 'Rewards Service → Customer Profile Service' and row[1] == 'Encryption in transit' for row in findings))
        self.assertTrue(any(row[0] == 'Analytics Warehouse' and row[1] == 'Encryption at rest' for row in findings))
        self.assertFalse(any(row[0] == 'Log Archive' for row in findings))
        self.assertFalse(any('FX Rates' in row[0] for row in findings))
        self.assertFalse(declared({'controls': {'security': {'description': 'encryption-in-transit'}}}, 'encryption-in-transit'))
        self.assertTrue(declared({'controls': {'security': {'requirements': [{'requirement-url': DEMO_CONTROL_BASE + 'encryption-in-transit'}]}}}, 'encryption-in-transit'))
        _, fx_links, fx_distances, _ = analyze(doc, 'fx-rates-service')
        self.assertEqual(demo_controls(nodes, fx_links, fx_distances, classifications), [])
        self.assertIn('No control rule set', lens(self.doc, 'rewards')['panels'][1]['blocks'][0]['text'])

    def test_team_architectures_support_list_metadata_and_unconfigured_rules(self):
        root = Path(__file__).resolve().parents[2] / 'calm-backstage' / 'seed' / 'architectures'
        for path in root.glob('*.architecture.json'):
            with self.subTest(path=path.name):
                doc = json.loads(path.read_text())
                result = lens(doc, doc['nodes'][0]['unique-id'])
                self.assertIn('Data classification not evaluated', result['panels'][0]['blocks'][1]['text'])
                self.assertIn('No control rule set', result['panels'][1]['blocks'][0]['text'])

    def test_invalid_origin_and_duplicate_ids(self):
        with self.assertRaises(ValueError): analyze(self.doc, 'missing')
        self.doc['nodes'].append(self.doc['nodes'][0])
        with self.assertRaises(ValueError): analyze(self.doc, 'rewards')


if __name__ == '__main__': unittest.main()
