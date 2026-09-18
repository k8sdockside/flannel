// What the pages know about Flannel.
//
// Flannel has no custom resources and no API of its own. Everything it knows is
// written in three places, and this file is the one that reads them:
//
//   - the ConfigMap (net-conf.json) — the cluster network, the backend and MTU;
//   - each Node's spec.podCIDR(s) — the slice flanneld leased to that node;
//   - each Node's flannel.alpha.coreos.com/* annotations — how peers reach it.
//
// Everything below the loaders is pure: it takes objects and returns objects, so
// the derivation can be reasoned about (and tested) without a cluster.

(function () {
    'use strict';

    var ANNOTATION_PREFIX = 'flannel.alpha.coreos.com/';

    // Flannel has moved namespaces across releases: kube-flannel since 0.21,
    // kube-system before it (and still, on Talos and kubeadm installs).
    var NAMESPACES = ['kube-flannel', 'kube-system'];
    var DAEMONSET_NAMES = ['kube-flannel-ds', 'kube-flannel'];
    var CONFIGMAP_NAMES = ['kube-flannel-cfg'];

    // ---------------------------------------------------------------- addresses

    // parseCIDR turns "10.244.1.0/24" or "fd00:10:244::/56" into a comparable
    // form. Addresses are held as BigInt so v4 and v6 can share one code path.
    function parseCIDR(text) {
        if (typeof text !== 'string' || text.indexOf('/') < 0) return null;
        var parts = text.trim().split('/');
        var prefix = Number(parts[1]);
        var addr = parseAddress(parts[0]);
        if (!addr || !isFinite(prefix)) return null;
        if (prefix < 0 || prefix > addr.bits) return null;
        var hostBits = BigInt(addr.bits - prefix);
        var size = 1n << hostBits;
        var mask = ~((1n << hostBits) - 1n) & ((1n << BigInt(addr.bits)) - 1n);
        var base = addr.value & mask;
        return {
            text: text.trim(),
            family: addr.bits === 32 ? 4 : 6,
            bits: addr.bits,
            prefix: prefix,
            base: base,
            size: size,
            end: base + size - 1n,
        };
    }

    // parseAddress accepts IPv4 dotted quads and IPv6 (including :: and the
    // v4-mapped tail form), returning the address as a BigInt.
    function parseAddress(text) {
        if (typeof text !== 'string') return null;
        var raw = text.trim();
        if (!raw) return null;
        if (raw.indexOf(':') < 0) return parseIPv4(raw);
        return parseIPv6(raw);
    }

    function parseIPv4(raw) {
        var octets = raw.split('.');
        if (octets.length !== 4) return null;
        var value = 0n;
        for (var i = 0; i < 4; i++) {
            if (!/^\d{1,3}$/.test(octets[i])) return null;
            var n = Number(octets[i]);
            if (n > 255) return null;
            value = (value << 8n) | BigInt(n);
        }
        return { value: value, bits: 32 };
    }

    function parseIPv6(raw) {
        // A trailing IPv4 form ("::ffff:10.0.0.1") is expanded to two groups.
        var tail = '';
        var lastColon = raw.lastIndexOf(':');
        var afterColon = raw.slice(lastColon + 1);
        if (afterColon.indexOf('.') >= 0) {
            var v4 = parseIPv4(afterColon);
            if (!v4) return null;
            var hi = (v4.value >> 16n) & 0xffffn;
            var lo = v4.value & 0xffffn;
            tail = hi.toString(16) + ':' + lo.toString(16);
            raw = raw.slice(0, lastColon + 1) + tail;
        }

        var halves = raw.split('::');
        if (halves.length > 2) return null;
        var head = halves[0] ? halves[0].split(':') : [];
        var rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
        if (halves.length === 1 && head.length !== 8) return null;
        if (head.length + rest.length > 8) return null;

        var groups = head.slice();
        for (var pad = 8 - head.length - rest.length; halves.length === 2 && pad > 0; pad--) groups.push('0');
        groups = groups.concat(rest);
        if (groups.length !== 8) return null;

        var value = 0n;
        for (var i = 0; i < 8; i++) {
            var g = groups[i] === '' ? '0' : groups[i];
            if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
            value = (value << 16n) | BigInt(parseInt(g, 16));
        }
        return { value: value, bits: 128 };
    }

    // contains reports whether outer wholly covers inner (same family only).
    function contains(outer, inner) {
        if (!outer || !inner || outer.family !== inner.family) return false;
        return inner.base >= outer.base && inner.end <= outer.end;
    }

    // addressIn reports whether a bare address falls inside a CIDR.
    function addressIn(cidr, text) {
        var addr = parseAddress(text);
        if (!cidr || !addr) return false;
        if ((addr.bits === 32 ? 4 : 6) !== cidr.family) return false;
        return addr.value >= cidr.base && addr.value <= cidr.end;
    }

    // offsetFraction is where inner starts inside outer, 0..1 — the x position
    // of a node's slice on the network bar.
    function offsetFraction(outer, inner) {
        if (!contains(outer, inner)) return null;
        return fraction(inner.base - outer.base, outer.size);
    }

    // sizeFraction is how much of outer inner covers, 0..1.
    function sizeFraction(outer, inner) {
        if (!outer || !inner) return null;
        return fraction(inner.size, outer.size);
    }

    // fraction divides two BigInts into a JS number without overflowing: a /56 of
    // a /8 is far beyond Number.MAX_SAFE_INTEGER, so the division is done in
    // BigInt against a fixed scale first.
    //
    // The scale is a power of two just under 2^53, so both the scaled quotient
    // and the final division are exact for the prefix-length ratios this deals
    // in. A decimal scale (1e6) silently truncated them — a /24 inside a /16
    // came out as 0.003906 rather than 0.00390625, and a small enough slice
    // rounded to zero and vanished from the map.
    var FRACTION_SCALE = 1n << 52n;
    var FRACTION_SCALE_NUMBER = Number(FRACTION_SCALE);

    function fraction(numerator, denominator) {
        if (denominator === 0n) return 0;
        return Number((numerator * FRACTION_SCALE) / denominator) / FRACTION_SCALE_NUMBER;
    }

    // ------------------------------------------------------------------ config

    // readConfig pulls the pieces the pages show out of net-conf.json. Flannel
    // tolerates a missing or partial file, so every field here is optional.
    function readConfig(configMap) {
        var out = {
            found: !!configMap,
            namespace: configMap && configMap.metadata ? configMap.metadata.namespace : null,
            name: configMap && configMap.metadata ? configMap.metadata.name : null,
            networks: [],
            backend: null,
            port: null,
            vni: null,
            mtu: null,
            nftables: null,
            raw: null,
            parseError: null,
        };
        if (!configMap || !configMap.data) return out;

        var text = configMap.data['net-conf.json'];
        out.raw = text || null;
        if (!text) return out;

        var conf;
        try {
            conf = JSON.parse(text);
        } catch (err) {
            out.parseError = err && err.message ? err.message : String(err);
            return out;
        }

        // "Network" is IPv4, "IPv6Network" is the v6 side of a dual-stack setup.
        [conf.Network, conf.IPv6Network].forEach(function (n) {
            var cidr = parseCIDR(n);
            if (cidr) out.networks.push(cidr);
        });

        if (conf.Backend && typeof conf.Backend === 'object') {
            out.backend = typeof conf.Backend.Type === 'string' ? conf.Backend.Type : null;
            out.port = isFinite(conf.Backend.Port) ? Number(conf.Backend.Port) : null;
            out.vni = isFinite(conf.Backend.VNI) ? Number(conf.Backend.VNI) : null;
        }
        if (isFinite(conf.MTU)) out.mtu = Number(conf.MTU);
        if (typeof conf.EnableNFTables === 'boolean') out.nftables = conf.EnableNFTables;
        return out;
    }

    // ------------------------------------------------------------------- nodes

    // readNode turns one Node into what Flannel put there: the subnet it leased
    // and how other nodes reach it.
    function readNode(node) {
        var meta = (node && node.metadata) || {};
        var ann = meta.annotations || {};
        var spec = (node && node.spec) || {};

        var cidrTexts = [];
        if (Array.isArray(spec.podCIDRs) && spec.podCIDRs.length) cidrTexts = spec.podCIDRs.slice();
        else if (spec.podCIDR) cidrTexts = [spec.podCIDR];

        var subnets = [];
        cidrTexts.forEach(function (t) {
            var cidr = parseCIDR(t);
            if (cidr) subnets.push(cidr);
        });

        var backendData = null;
        var backendDataError = null;
        if (ann[ANNOTATION_PREFIX + 'backend-data']) {
            try {
                backendData = JSON.parse(ann[ANNOTATION_PREFIX + 'backend-data']);
            } catch (err) {
                backendDataError = err && err.message ? err.message : String(err);
            }
        }

        return {
            name: meta.name || '',
            subnets: subnets,
            // Annotated only once flanneld on that node has taken its lease, so
            // its absence is the signal that a node is not yet in the network.
            leased: !!ann[ANNOTATION_PREFIX + 'backend-type'],
            backendType: ann[ANNOTATION_PREFIX + 'backend-type'] || null,
            publicIP: ann[ANNOTATION_PREFIX + 'public-ip'] || null,
            publicIPv6: ann[ANNOTATION_PREFIX + 'public-ipv6'] || null,
            subnetManager: ann[ANNOTATION_PREFIX + 'kube-subnet-manager'] === 'true',
            backendData: backendData,
            backendDataError: backendDataError,
            vtepMAC: backendData && backendData.VtepMAC ? backendData.VtepMAC : null,
            vni: backendData && isFinite(backendData.VNI) ? Number(backendData.VNI) : null,
            ready: nodeReady(node),
            unschedulable: !!spec.unschedulable,
        };
    }

    function nodeReady(node) {
        var conds = (node && node.status && node.status.conditions) || [];
        for (var i = 0; i < conds.length; i++) {
            if (conds[i].type === 'Ready') return conds[i].status === 'True';
        }
        return null;
    }

    // --------------------------------------------------------------- the whole

    // build is the one derivation the pages share: config + nodes + pods ->
    // everything drawn, plus the problems worth naming.
    function build(input) {
        var config = readConfig(input.configMap);
        var nodes = (input.nodes || []).map(readNode);
        var pods = input.pods || [];

        // Count pods per node, ignoring the ones that share the node's address
        // (host-network pods never come from a Flannel subnet).
        var podCounts = {};
        var hostNetwork = 0;
        pods.forEach(function (pod) {
            var spec = pod.spec || {};
            var status = pod.status || {};
            if (!spec.nodeName) return;
            if (spec.hostNetwork) {
                hostNetwork++;
                return;
            }
            if (!status.podIP) return;
            podCounts[spec.nodeName] = (podCounts[spec.nodeName] || 0) + 1;
        });

        nodes.forEach(function (n) {
            n.podCount = podCounts[n.name] || 0;
            n.placements = config.networks
                .map(function (net) {
                    var subnet = firstInFamily(n.subnets, net.family);
                    if (!subnet) return null;
                    return {
                        network: net,
                        subnet: subnet,
                        offset: offsetFraction(net, subnet),
                        size: sizeFraction(net, subnet),
                        outside: !contains(net, subnet),
                    };
                })
                .filter(Boolean);
        });

        nodes.sort(function (a, b) {
            var av = a.subnets.length ? a.subnets[0].base : 0n;
            var bv = b.subnets.length ? b.subnets[0].base : 0n;
            if (av === bv) return a.name.localeCompare(b.name);
            return av < bv ? -1 : 1;
        });

        return {
            config: config,
            nodes: nodes,
            hostNetworkPods: hostNetwork,
            daemonset: input.daemonset || null,
            flannelPods: input.flannelPods || [],
            problems: findProblems(config, nodes, input.daemonset, input.flannelPods || []),
        };
    }

    function firstInFamily(subnets, family) {
        for (var i = 0; i < subnets.length; i++) {
            if (subnets[i].family === family) return subnets[i];
        }
        return null;
    }

    // findProblems names what is actually wrong, in the order someone would want
    // to act on it. Each one carries enough to explain itself on the page.
    function findProblems(config, nodes, daemonset, flannelPods) {
        var problems = [];

        if (!daemonset) {
            problems.push({
                id: 'no-daemonset',
                tone: 'error',
                title: 'No Flannel daemonset found',
                detail:
                    'Looked for ' +
                    DAEMONSET_NAMES.join(' or ') +
                    ' in ' +
                    NAMESPACES.join(' and ') +
                    '. Flannel may be installed elsewhere, or this cluster may use another CNI.',
            });
        } else {
            var st = daemonset.status || {};
            var desired = st.desiredNumberScheduled || 0;
            var ready = st.numberReady || 0;
            if (desired > 0 && ready < desired) {
                problems.push({
                    id: 'daemonset-degraded',
                    tone: ready === 0 ? 'error' : 'warn',
                    title: ready + ' of ' + desired + ' Flannel pods are ready',
                    detail:
                        'Pods on the nodes that are not ready cannot program routes, so traffic to and from those nodes will not work.',
                });
            }
        }

        if (!config.found) {
            problems.push({
                id: 'no-config',
                tone: 'warn',
                title: 'No Flannel ConfigMap found',
                detail:
                    'Looked for ' +
                    CONFIGMAP_NAMES.join(' or ') +
                    ' in ' +
                    NAMESPACES.join(' and ') +
                    '. Without net-conf.json the network and backend below are read from the nodes alone.',
            });
        } else if (config.parseError) {
            problems.push({
                id: 'bad-config',
                tone: 'error',
                title: 'net-conf.json could not be read',
                detail: config.parseError,
            });
        } else if (!config.networks.length) {
            problems.push({
                id: 'no-network',
                tone: 'warn',
                title: 'net-conf.json names no network',
                detail: 'Without "Network" the per-node subnets cannot be placed on the cluster network.',
            });
        }

        var unleased = nodes.filter(function (n) {
            return !n.leased;
        });
        if (unleased.length) {
            problems.push({
                id: 'unleased',
                tone: 'warn',
                title:
                    unleased.length === 1
                        ? 'One node has no Flannel lease'
                        : unleased.length + ' nodes have no Flannel lease',
                detail:
                    'flanneld writes its annotations on a node once it starts there. Until then the node has no route to the pod network: ' +
                    unleased
                        .map(function (n) {
                            return n.name;
                        })
                        .join(', ') +
                    '.',
            });
        }

        var noSubnet = nodes.filter(function (n) {
            return n.leased && !n.subnets.length;
        });
        if (noSubnet.length) {
            problems.push({
                id: 'no-podcidr',
                tone: 'error',
                title: 'A node has no podCIDR',
                detail:
                    'With --kube-subnet-mgr, flanneld takes the node’s podCIDR as its lease. The controller manager has not assigned one to: ' +
                    noSubnet
                        .map(function (n) {
                            return n.name;
                        })
                        .join(', ') +
                    '.',
            });
        }

        var outside = [];
        nodes.forEach(function (n) {
            (n.placements || []).forEach(function (p) {
                if (p.outside) outside.push(n.name + ' (' + p.subnet.text + ')');
            });
        });
        if (outside.length) {
            problems.push({
                id: 'outside-network',
                tone: 'error',
                title: 'A node subnet falls outside the Flannel network',
                detail:
                    'These leases are not inside the network net-conf.json declares, so their pods are not routable: ' +
                    outside.join(', ') +
                    '.',
            });
        }

        // A backend changed in the ConfigMap only takes effect where flanneld has
        // restarted, and a half-converted cluster drops traffic between the two
        // halves — worth naming rather than leaving to be discovered.
        if (config.backend) {
            var mismatched = nodes.filter(function (n) {
                return n.leased && n.backendType && n.backendType !== config.backend;
            });
            if (mismatched.length) {
                problems.push({
                    id: 'backend-mismatch',
                    tone: 'error',
                    title: 'Nodes disagree with the configured backend',
                    detail:
                        'net-conf.json says "' +
                        config.backend +
                        '", but these nodes are annotated with something else: ' +
                        mismatched
                            .map(function (n) {
                                return n.name + ' (' + n.backendType + ')';
                            })
                            .join(', ') +
                        '. Restart flanneld on them to pick up the change.',
                });
            }
        }

        var overlaps = findOverlaps(nodes);
        overlaps.forEach(function (pair) {
            problems.push({
                id: 'overlap-' + pair[0] + '-' + pair[1],
                tone: 'error',
                title: 'Two nodes hold overlapping subnets',
                detail: pair[0] + ' and ' + pair[1] + ' both cover addresses in the same range.',
            });
        });

        var badData = nodes.filter(function (n) {
            return n.backendDataError;
        });
        if (badData.length) {
            problems.push({
                id: 'bad-backend-data',
                tone: 'warn',
                title: 'A node’s backend-data could not be read',
                detail: badData
                    .map(function (n) {
                        return n.name + ': ' + n.backendDataError;
                    })
                    .join('; '),
            });
        }

        var crashing = flannelPods.filter(function (p) {
            return podTrouble(p);
        });
        if (crashing.length) {
            problems.push({
                id: 'pods-unhealthy',
                tone: 'warn',
                title:
                    crashing.length === 1
                        ? 'A Flannel pod is not running'
                        : crashing.length + ' Flannel pods are not running',
                detail: crashing
                    .map(function (p) {
                        return p.metadata.name + ': ' + podTrouble(p);
                    })
                    .join('; '),
            });
        }

        return problems;
    }

    // podTrouble returns a short reason a Flannel pod is not serving, or "".
    function podTrouble(pod) {
        var status = pod.status || {};
        if (status.phase === 'Running') {
            var statuses = status.containerStatuses || [];
            for (var i = 0; i < statuses.length; i++) {
                var cs = statuses[i];
                if (cs.ready) continue;
                if (cs.state && cs.state.waiting && cs.state.waiting.reason) return cs.state.waiting.reason;
                return 'not ready';
            }
            return '';
        }
        if (status.phase === 'Succeeded') return '';
        return status.reason || status.phase || 'unknown';
    }

    // findOverlaps returns pairs of node names whose subnets intersect.
    function findOverlaps(nodes) {
        var pairs = [];
        for (var i = 0; i < nodes.length; i++) {
            for (var j = i + 1; j < nodes.length; j++) {
                if (overlapping(nodes[i].subnets, nodes[j].subnets)) pairs.push([nodes[i].name, nodes[j].name]);
            }
        }
        return pairs;
    }

    function overlapping(a, b) {
        for (var i = 0; i < a.length; i++) {
            for (var j = 0; j < b.length; j++) {
                if (a[i].family !== b[j].family) continue;
                if (a[i].base <= b[j].end && b[j].base <= a[i].end) return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ loading

    // load fetches everything the pages need, tolerating the pieces that may not
    // be there. Flannel's namespace has moved between releases, so each lookup
    // tries the known places in turn rather than assuming one.
    async function load() {
        var nodes = await safeList({ kind: 'nodes' });
        var pods = await safeList({ kind: 'pods' });

        var daemonset = await findFirst('daemonsets', NAMESPACES, DAEMONSET_NAMES);
        var configMap = await findFirst('configmaps', NAMESPACES, CONFIGMAP_NAMES);

        var flannelPods = pods.filter(function (p) {
            var labels = (p.metadata && p.metadata.labels) || {};
            return labels['k8s-app'] === 'flannel' || labels.app === 'flannel';
        });

        return build({
            nodes: nodes,
            pods: pods,
            daemonset: daemonset,
            configMap: configMap,
            flannelPods: flannelPods,
        });
    }

    async function findFirst(kind, namespaces, names) {
        for (var i = 0; i < namespaces.length; i++) {
            for (var j = 0; j < names.length; j++) {
                try {
                    var obj = await k8sdockside.get({ kind: kind, namespace: namespaces[i], name: names[j] });
                    if (obj) return obj;
                } catch (err) {
                    // Not there, or not readable: try the next place.
                }
            }
        }
        return null;
    }

    async function safeList(query) {
        try {
            var items = await k8sdockside.list(query);
            return Array.isArray(items) ? items : [];
        } catch (err) {
            return [];
        }
    }

    window.Flannel = window.Flannel || {};
    window.Flannel.model = {
        ANNOTATION_PREFIX: ANNOTATION_PREFIX,
        NAMESPACES: NAMESPACES,
        parseCIDR: parseCIDR,
        parseAddress: parseAddress,
        contains: contains,
        addressIn: addressIn,
        offsetFraction: offsetFraction,
        sizeFraction: sizeFraction,
        readConfig: readConfig,
        readNode: readNode,
        build: build,
        findProblems: findProblems,
        podTrouble: podTrouble,
        load: load,
        safeList: safeList,
        findFirst: findFirst,
    };
})();
