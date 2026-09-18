// The Subnet map: the cluster network drawn to scale, every node's lease placed
// where it actually falls, and a row per node under it. Selecting either one
// highlights the other, so "which slice is this node" needs no reading.

(function () {
    'use strict';

    var kit = window.Flannel.kit;
    var model = window.Flannel.model;
    var el = kit.el;

    var view = null;
    var selected = null;

    k8sdockside
        .ready()
        .then(start)
        .catch(kit.showError);

    async function start() {
        try {
            view = await model.load();
        } catch (err) {
            kit.showError(err);
            return;
        }
        draw();
    }

    function draw() {
        drawIntro();
        drawMaps();
        drawTable();
    }

    function drawIntro() {
        var host = kit.clear(document.getElementById('intro'));
        var cfg = view.config;

        if (!cfg.networks.length) {
            host.appendChild(
                kit.verdict(
                    'warn',
                    'No cluster network to draw',
                    'net-conf.json does not name a network, so the leases below cannot be placed against it.'
                )
            );
            return;
        }

        var used = 0;
        var total = 0;
        view.nodes.forEach(function (n) {
            n.placements.forEach(function (p) {
                if (p.network.family !== 4 || p.outside) return;
                used += p.size;
            });
        });
        cfg.networks.forEach(function (n) {
            if (n.family === 4) total += 1;
        });

        var percent = total ? Math.round(used * 100) : 0;
        host.appendChild(
            kit.verdict(
                'ok',
                view.nodes.length + ' nodes hold a slice of the pod network',
                cfg.networks
                    .map(function (n) {
                        return n.text;
                    })
                    .join(' and ') +
                    (total ? ' — about ' + percent + '% of the IPv4 network is leased.' : '')
            )
        );
    }

    function drawMaps() {
        var host = document.getElementById('maps');
        kit.clear(host);
        if (!view.config.networks.length) {
            host.hidden = true;
            return;
        }
        host.hidden = false;

        var body = el('div', {});
        view.config.networks.forEach(function (net) {
            var slices = [];
            view.nodes.forEach(function (node) {
                node.placements.forEach(function (p) {
                    if (p.network !== net) return;
                    slices.push({
                        offset: p.offset,
                        size: p.size,
                        tone: p.outside ? 'error' : node.leased ? 'ok' : 'warn',
                        selected: selected === node.name,
                        // A node's slice fills by how much of its own subnet is
                        // handed out to pods, so a node running hot is visible
                        // without opening it.
                        fill: fillFor(node, p),
                        title:
                            node.name +
                            ' — ' +
                            p.subnet.text +
                            ' · ' +
                            (node.podCount || 0) +
                            ' pods' +
                            (p.outside ? ' · outside the network' : ''),
                        onSelect: function () {
                            selected = selected === node.name ? null : node.name;
                            draw();
                        },
                    });
                });
            });
            body.appendChild(kit.networkBar(net, slices, { interactive: true }));
        });

        host.appendChild(
            kit.section(
                'The cluster network, to scale',
                'Width is the size of the lease. The bar inside it is how much of that lease is in use. Click a slice to pin it.',
                body
            )
        );
    }

    // fillFor is the share of a node's own subnet that is in use, 0..1. Two
    // addresses in every subnet are not usable (network and gateway), which
    // matters on a /30 and rounds to nothing on a /24.
    function fillFor(node, placement) {
        var usable = Number(placement.subnet.size) - 2;
        if (!isFinite(usable) || usable <= 0) return 0;
        return Math.min(1, (node.podCount || 0) / usable);
    }

    function drawTable() {
        var host = document.getElementById('table');
        kit.clear(host);
        host.hidden = false;

        var table = el('table', { class: 'rows' });
        table.appendChild(
            el(
                'thead',
                {},
                el(
                    'tr',
                    {},
                    el('th', { text: 'Node' }),
                    el('th', { text: 'Subnet' }),
                    el('th', { text: 'Pods' }),
                    el('th', { text: 'Backend' }),
                    el('th', { text: 'Endpoint' }),
                    el('th', { text: 'VTEP MAC' })
                )
            )
        );

        var tbody = el('tbody', {});
        view.nodes.forEach(function (node) {
            var subnets = node.subnets
                .map(function (s) {
                    return s.text;
                })
                .join(', ');

            var row = el(
                'tr',
                { class: 'is-clickable' + (selected === node.name ? ' is-selected' : '') },
                el('td', { text: node.name }),
                el('td', { class: 'mono' + (node.subnets.length ? '' : ' tone-error'), text: subnets || 'no podCIDR' }),
                el('td', { text: String(node.podCount || 0) }),
                el('td', {
                    class: backendTone(node),
                    text: node.leased ? node.backendType || '—' : 'no lease',
                }),
                el('td', { class: 'mono', text: node.publicIP || node.publicIPv6 || '—' }),
                el('td', { class: 'mono', text: node.vtepMAC || '—' })
            );
            row.onclick = function () {
                selected = selected === node.name ? null : node.name;
                draw();
            };
            row.ondblclick = function () {
                k8sdockside.open({ kind: 'nodes', name: node.name });
            };
            tbody.appendChild(row);
        });
        table.appendChild(tbody);

        host.appendChild(
            kit.section(
                'Leases',
                'Click to pin a node on the map above; double-click to open the node.',
                view.nodes.length ? table : kit.empty('No nodes.')
            )
        );
    }

    function backendTone(node) {
        if (!node.leased) return 'tone-warn';
        if (view.config.backend && node.backendType && node.backendType !== view.config.backend) return 'tone-error';
        return '';
    }
})();
