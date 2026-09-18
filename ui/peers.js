// Backend & peers: how the nodes reach each other, and whether they agree about
// it. With VXLAN that is a full mesh of tunnels keyed by VTEP MAC; with host-gw
// it is plain routes and every node must be on one subnet; with WireGuard it is
// an encrypted mesh. Which one is in use changes what can go wrong, so the page
// says what that is rather than drawing the same picture for all three.

(function () {
    'use strict';

    var kit = window.Flannel.kit;
    var model = window.Flannel.model;
    var el = kit.el;

    // What each backend needs of the network underneath it. Flannel's own
    // documentation is the source; this is the part that explains a failure.
    var BACKENDS = {
        vxlan: {
            title: 'VXLAN',
            how: 'Each node wraps pod traffic in a UDP tunnel to the node holding the destination subnet.',
            needs: 'The UDP port below must be open between every pair of node endpoints. Nodes need not share a subnet.',
        },
        'host-gw': {
            title: 'host-gw',
            how: 'Each node adds a plain route to every other node’s subnet, via that node’s address. No encapsulation, so no overhead.',
            needs: 'Every node must be on the same layer-2 network — a router between any two nodes breaks it.',
        },
        wireguard: {
            title: 'WireGuard',
            how: 'Pod traffic runs over an encrypted WireGuard tunnel between nodes.',
            needs: 'The WireGuard UDP port must be open between node endpoints, and the wireguard module must be loaded on every node.',
        },
        'vxlan-directrouting': {
            title: 'VXLAN with DirectRouting',
            how: 'Nodes on the same subnet route directly; nodes that are not fall back to a VXLAN tunnel.',
            needs: 'Both the UDP port between endpoints, and layer-2 adjacency for the direct-routing half to be used.',
        },
        udp: {
            title: 'UDP',
            how: 'Traffic is encapsulated in userspace. Flannel ships this for debugging only.',
            needs: 'Not for production use — it is slow. Prefer vxlan.',
        },
    };

    k8sdockside
        .ready()
        .then(start)
        .catch(kit.showError);

    async function start() {
        var view;
        try {
            view = await model.load();
        } catch (err) {
            kit.showError(err);
            return;
        }
        drawBackend(view);
        drawMesh(view);
    }

    function drawBackend(view) {
        var host = kit.clear(document.getElementById('backend'));
        var cfg = view.config;
        var name = cfg.backend || firstNodeBackend(view) || 'unknown';
        var known = BACKENDS[String(name).toLowerCase()];

        host.appendChild(
            kit.verdict(
                known ? 'ok' : 'warn',
                known ? known.title : 'Backend: ' + name,
                known ? known.how : 'This plugin has no notes on this backend; Flannel’s documentation will.'
            )
        );

        var body = el('div', {});
        if (known) body.appendChild(kit.field('What it needs', known.needs));
        if (cfg.port) body.appendChild(kit.field('UDP port', cfg.port, { mono: true }));
        if (cfg.vni !== null) body.appendChild(kit.field('VNI', cfg.vni, { mono: true }));
        if (cfg.mtu !== null) body.appendChild(kit.field('MTU', cfg.mtu, { mono: true }));
        if (cfg.nftables !== null) body.appendChild(kit.field('Dataplane', cfg.nftables ? 'nftables' : 'iptables'));
        cfg.networks.forEach(function (net) {
            body.appendChild(kit.field(net.family === 6 ? 'IPv6 network' : 'Network', net.text, { mono: true }));
        });

        // host-gw is the one backend whose requirement can be checked from here:
        // every node endpoint has to be on one subnet.
        if (String(name).toLowerCase() === 'host-gw') {
            var spread = endpointSpread(view);
            if (spread.distinctPrefixes > 1) {
                body.appendChild(
                    kit.field('Node endpoints', spread.summary, { tone: 'warn' })
                );
            }
        }

        host.appendChild(kit.section('The backend', cfg.found ? 'From net-conf.json.' : 'Read from the node annotations.', body));
    }

    function firstNodeBackend(view) {
        for (var i = 0; i < view.nodes.length; i++) {
            if (view.nodes[i].backendType) return view.nodes[i].backendType;
        }
        return null;
    }

    // endpointSpread is a rough check that host-gw's layer-2 requirement holds:
    // it compares the /24 of each node endpoint, which is what an operator would
    // eyeball. It is a hint, not a routing table.
    function endpointSpread(view) {
        var prefixes = {};
        view.nodes.forEach(function (n) {
            if (!n.publicIP) return;
            var parts = n.publicIP.split('.');
            if (parts.length === 4) prefixes[parts.slice(0, 3).join('.') + '.0/24'] = true;
        });
        var keys = Object.keys(prefixes);
        return {
            distinctPrefixes: keys.length,
            summary:
                keys.length > 1
                    ? 'Endpoints span ' + keys.join(', ') + ' — host-gw needs every node on one layer-2 network.'
                    : keys.join(''),
        };
    }

    function drawMesh(view) {
        var host = document.getElementById('mesh');
        kit.clear(host);
        host.hidden = false;

        var leased = view.nodes.filter(function (n) {
            return n.leased;
        });

        var table = el('table', { class: 'rows' });
        table.appendChild(
            el(
                'thead',
                {},
                el(
                    'tr',
                    {},
                    el('th', { text: 'Node' }),
                    el('th', { text: 'Reached at' }),
                    el('th', { text: 'Backend' }),
                    el('th', { text: 'VTEP MAC' }),
                    el('th', { text: 'VNI' }),
                    el('th', { text: 'Serves' })
                )
            )
        );

        var tbody = el('tbody', {});
        view.nodes.forEach(function (node) {
            var row = el(
                'tr',
                { class: 'is-clickable' },
                el('td', { text: node.name }),
                el('td', { class: 'mono' + (node.publicIP || node.publicIPv6 ? '' : ' tone-warn'), text: node.publicIP || node.publicIPv6 || 'not annotated' }),
                el('td', { text: node.backendType || '—' }),
                el('td', { class: 'mono', text: node.vtepMAC || '—' }),
                el('td', { class: 'mono', text: node.vni === null ? '—' : String(node.vni) }),
                el('td', {
                    class: 'mono',
                    text:
                        node.subnets
                            .map(function (s) {
                                return s.text;
                            })
                            .join(', ') || '—',
                })
            );
            row.onclick = function () {
                k8sdockside.open({ kind: 'nodes', name: node.name });
            };
            tbody.appendChild(row);
        });
        table.appendChild(tbody);

        var note =
            leased.length > 1
                ? 'Every node holds a tunnel to every other: ' + (leased.length * (leased.length - 1)) / 2 + ' pairs.'
                : 'One node holds a lease, so there is nothing to tunnel to yet.';

        host.appendChild(kit.section('Nodes and how they are reached', note, view.nodes.length ? table : kit.empty('No nodes.')));

        // Duplicate VTEP MACs mean two nodes claim the same tunnel endpoint,
        // which silently blackholes traffic to one of them.
        var byMAC = {};
        view.nodes.forEach(function (n) {
            if (!n.vtepMAC) return;
            (byMAC[n.vtepMAC] = byMAC[n.vtepMAC] || []).push(n.name);
        });
        var clashes = Object.keys(byMAC).filter(function (mac) {
            return byMAC[mac].length > 1;
        });
        if (clashes.length) {
            host.appendChild(
                kit.section(
                    'Clashing tunnel endpoints',
                    null,
                    kit.problemList(
                        clashes.map(function (mac) {
                            return {
                                tone: 'error',
                                title: 'Two nodes share the VTEP MAC ' + mac,
                                detail: byMAC[mac].join(' and ') + ' both claim it, so traffic to one of them will not arrive.',
                            };
                        })
                    )
                )
            );
        }
    }
})();
