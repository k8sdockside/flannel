// The overview: is Flannel working, how is this network built, and what needs
// attention. Everything here comes from the three places Flannel writes to —
// there is no Flannel API to ask.

(function () {
    'use strict';

    var kit = window.Flannel.kit;
    var model = window.Flannel.model;
    var el = kit.el;

    k8sdockside
        .ready()
        .then(render)
        .catch(kit.showError);

    async function render() {
        var view;
        try {
            view = await model.load();
        } catch (err) {
            kit.showError(err);
            return;
        }

        drawVerdict(view);
        drawShape(view);
        drawMap(view);
        drawAttention(view);
        drawComponents(view);
        await drawEvents();
    }

    // ------------------------------------------------------------------ verdict

    function drawVerdict(view) {
        var host = kit.clear(document.getElementById('verdict'));
        var worst = worstTone(view.problems);
        var leased = view.nodes.filter(function (n) {
            return n.leased;
        }).length;

        var headline;
        var detail;
        if (!view.daemonset) {
            headline = 'Flannel does not appear to be installed here';
            detail =
                'No kube-flannel daemonset in ' +
                model.NAMESPACES.join(' or ') +
                '. If this cluster uses another CNI, that plugin will have more to say than this one.';
        } else if (worst === 'error') {
            headline = 'Flannel is not healthy';
            detail = 'The pod network is likely broken between some nodes. What is wrong is listed below.';
        } else if (worst === 'warn') {
            headline = 'Flannel is up, with something worth a look';
            detail = leased + ' of ' + view.nodes.length + ' nodes hold a lease.';
        } else {
            headline = 'Flannel is healthy';
            detail =
                'All ' +
                view.nodes.length +
                ' nodes hold a lease' +
                (view.config.backend ? ' and speak ' + view.config.backend : '') +
                '.';
        }

        host.appendChild(kit.verdict(worst === 'none' ? 'ok' : worst, headline, detail));
    }

    function worstTone(problems) {
        var tone = 'none';
        problems.forEach(function (p) {
            if (p.tone === 'error') tone = 'error';
            else if (p.tone === 'warn' && tone !== 'error') tone = 'warn';
        });
        return tone;
    }

    // -------------------------------------------------------------------- shape

    // How this network is built: the facts from net-conf.json, checked against
    // what the nodes are actually annotated with.
    function drawShape(view) {
        var host = document.getElementById('shape');
        kit.clear(host);
        host.hidden = false;

        var cfg = view.config;
        var chips = el('div', { class: 'chips' });

        var backends = {};
        view.nodes.forEach(function (n) {
            if (n.backendType) backends[n.backendType] = (backends[n.backendType] || 0) + 1;
        });
        var backendNames = Object.keys(backends);
        var backendTone = 'ok';
        if (cfg.backend && backendNames.some(function (b) {
            return b !== cfg.backend;
        })) {
            backendTone = 'error';
        }

        chips.appendChild(kit.chip('Backend', cfg.backend || backendNames.join(', ') || 'unknown', backendTone));
        if (cfg.port) chips.appendChild(kit.chip('Port', cfg.port));
        if (cfg.vni !== null) chips.appendChild(kit.chip('VNI', cfg.vni));
        if (cfg.mtu !== null) chips.appendChild(kit.chip('MTU', cfg.mtu));
        if (cfg.nftables !== null) chips.appendChild(kit.chip('Dataplane', cfg.nftables ? 'nftables' : 'iptables'));
        cfg.networks.forEach(function (net) {
            chips.appendChild(kit.chip(net.family === 6 ? 'IPv6 network' : 'Network', net.text));
        });
        chips.appendChild(
            kit.chip(
                'Subnet manager',
                view.nodes.length && view.nodes.every(function (n) {
                    return !n.leased || n.subnetManager;
                })
                    ? 'kube (podCIDR)'
                    : 'etcd or mixed'
            )
        );

        var stats = el(
            'div',
            { class: 'stats' },
            kit.stat(view.nodes.length, 'nodes'),
            kit.stat(
                view.nodes.filter(function (n) {
                    return n.leased;
                }).length,
                'leases'
            ),
            kit.stat(
                view.nodes.reduce(function (sum, n) {
                    return sum + (n.podCount || 0);
                }, 0),
                'pods on the overlay'
            ),
            kit.stat(view.hostNetworkPods, 'host-network pods')
        );

        host.appendChild(
            kit.section(
                'How this network is built',
                cfg.found
                    ? 'From ' + cfg.namespace + '/' + cfg.name + ' (net-conf.json), checked against every node.'
                    : 'No ConfigMap found — read from the nodes alone.',
                el('div', {}, stats, el('div', { style: 'height:12px' }), chips)
            )
        );
    }

    // ---------------------------------------------------------------------- map

    // The cluster network to scale, with each node's slice where it falls. The
    // same picture the Subnet map view opens with, without the detail.
    function drawMap(view) {
        var host = document.getElementById('map');
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
                        title: node.name + ' — ' + p.subnet.text,
                    });
                });
            });
            body.appendChild(kit.networkBar(net, slices));
        });

        body.appendChild(
            el(
                'div',
                { class: 'legend' },
                legendItem('ok', 'leased'),
                legendItem('warn', 'no lease yet'),
                legendItem('error', 'outside the network')
            )
        );

        host.appendChild(
            kit.section(
                'The cluster network',
                'Each node holds one slice. Width is how much of the network it is; the gaps are unallocated.',
                body
            )
        );
    }

    function legendItem(tone, label) {
        var swatch = el('span', { class: 'legend-swatch' });
        swatch.style.background = 'var(--fl-' + tone + ')';
        return el('span', { class: 'legend-item' }, swatch, el('span', { text: label }));
    }

    // --------------------------------------------------------------- attention

    function drawAttention(view) {
        var host = kit.clear(document.getElementById('attention'));
        document.getElementById('columns').hidden = false;
        host.appendChild(
            kit.section(
                'What needs attention',
                null,
                view.problems.length ? kit.problemList(view.problems) : kit.empty('Nothing. Every node holds a lease inside the network.')
            )
        );
    }

    // -------------------------------------------------------------- components

    function drawComponents(view) {
        var host = kit.clear(document.getElementById('components'));
        var ds = view.daemonset;

        var body = el('div', {});
        if (ds) {
            var st = ds.status || {};
            body.appendChild(kit.field('Daemonset', (ds.metadata.namespace || '') + '/' + (ds.metadata.name || ''), { mono: true }));
            body.appendChild(
                kit.field('Ready', (st.numberReady || 0) + ' of ' + (st.desiredNumberScheduled || 0), {
                    tone: (st.numberReady || 0) >= (st.desiredNumberScheduled || 0) ? 'ok' : 'error',
                })
            );
            if (st.numberUnavailable) body.appendChild(kit.field('Unavailable', st.numberUnavailable, { tone: 'warn' }));
            var image = imageOf(ds);
            if (image) body.appendChild(kit.field('Image', image, { mono: true }));
        } else {
            body.appendChild(kit.empty('No kube-flannel daemonset found.'));
        }

        var table = el('table', { class: 'rows' });
        table.appendChild(
            el('thead', {}, el('tr', {}, el('th', { text: 'Pod' }), el('th', { text: 'Node' }), el('th', { text: 'State' })))
        );
        var tbody = el('tbody', {});
        view.flannelPods
            .slice()
            .sort(function (a, b) {
                return (a.spec.nodeName || '').localeCompare(b.spec.nodeName || '');
            })
            .forEach(function (pod) {
                var trouble = model.podTrouble(pod);
                var row = el(
                    'tr',
                    { class: 'is-clickable' },
                    el('td', { class: 'mono', text: pod.metadata.name }),
                    el('td', { text: pod.spec.nodeName || '—' }),
                    el('td', { class: trouble ? 'tone-error' : 'tone-ok', text: trouble || 'running' })
                );
                row.onclick = function () {
                    k8sdockside.open({ kind: 'pods', namespace: pod.metadata.namespace, name: pod.metadata.name });
                };
                tbody.appendChild(row);
            });
        table.appendChild(tbody);

        if (view.flannelPods.length) body.appendChild(el('div', { style: 'height:12px' }, table));

        host.appendChild(kit.section('Flannel itself', null, body));
    }

    function imageOf(ds) {
        var spec = ds.spec && ds.spec.template && ds.spec.template.spec;
        if (!spec) return null;
        var containers = spec.containers || [];
        for (var i = 0; i < containers.length; i++) {
            if ((containers[i].name || '').indexOf('flannel') >= 0) return containers[i].image;
        }
        return containers.length ? containers[0].image : null;
    }

    // ------------------------------------------------------------------ events

    // Flannel's own recent events, when the app lets the page read them.
    async function drawEvents() {
        var host = document.getElementById('events');
        var events = await model.safeList({ kind: 'events' });
        var mine = events
            .filter(function (e) {
                var obj = e.involvedObject || {};
                var name = obj.name || '';
                return name.indexOf('flannel') >= 0 || (e.source && (e.source.component || '').indexOf('flannel') >= 0);
            })
            .sort(function (a, b) {
                return Date.parse(b.lastTimestamp || b.eventTime || 0) - Date.parse(a.lastTimestamp || a.eventTime || 0);
            })
            .slice(0, 12);

        if (!mine.length) {
            host.hidden = true;
            return;
        }
        host.hidden = false;
        kit.clear(host);

        var table = el('table', { class: 'rows' });
        table.appendChild(
            el(
                'thead',
                {},
                el('tr', {}, el('th', { text: 'When' }), el('th', { text: 'Reason' }), el('th', { text: 'Object' }), el('th', { text: 'Message' }))
            )
        );
        var tbody = el('tbody', {});
        mine.forEach(function (e) {
            tbody.appendChild(
                el(
                    'tr',
                    {},
                    el('td', { text: kit.relative(e.lastTimestamp || e.eventTime) }),
                    el('td', { class: e.type === 'Warning' ? 'tone-warn' : '', text: e.reason || '' }),
                    el('td', { class: 'mono', text: (e.involvedObject && e.involvedObject.name) || '' }),
                    el('td', { text: e.message || '' })
                )
            );
        });
        table.appendChild(tbody);
        host.appendChild(kit.section('Recent events', null, table));
    }
})();
