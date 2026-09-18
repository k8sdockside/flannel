// The Flannel panel on a Node: the slice it holds, and how other nodes reach it.

(function () {
    'use strict';

    var kit = window.Flannel.kit;
    var model = window.Flannel.model;
    var el = kit.el;

    k8sdockside
        .ready()
        .then(start)
        .catch(kit.showError);

    async function start() {
        var node = await k8sdockside.object();
        var host = kit.clear(document.getElementById('body'));
        var read = model.readNode(node);

        if (!read.leased && !read.subnets.length) {
            host.appendChild(
                kit.verdict(
                    'warn',
                    'Flannel has not leased this node a subnet',
                    'No flannel.alpha.coreos.com annotations and no podCIDR. Until flanneld runs here, pods on this node have no route to the rest of the cluster.'
                )
            );
            resize();
            return;
        }

        var config = model.readConfig(await model.findFirst('configmaps', model.NAMESPACES, ['kube-flannel-cfg']));

        var body = el('div', {});
        read.subnets.forEach(function (subnet) {
            body.appendChild(kit.field(subnet.family === 6 ? 'IPv6 subnet' : 'Subnet', subnet.text, { mono: true }));
            body.appendChild(
                kit.field(
                    'Addresses',
                    kit.firstAddress(subnet) + ' – ' + kit.lastAddress(subnet),
                    { mono: true }
                )
            );
        });
        if (!read.subnets.length) {
            body.appendChild(kit.field('Subnet', 'no podCIDR assigned', { tone: 'error' }));
        }

        var mismatch = config.backend && read.backendType && read.backendType !== config.backend;
        body.appendChild(
            kit.field('Backend', read.backendType || 'not annotated', { tone: mismatch ? 'error' : read.backendType ? 'ok' : 'warn' })
        );
        if (mismatch) {
            body.appendChild(
                kit.field('Configured backend', config.backend, { tone: 'error' })
            );
        }
        body.appendChild(kit.field('Reached at', read.publicIP || read.publicIPv6 || 'not annotated', { mono: true }));
        if (read.vtepMAC) body.appendChild(kit.field('VTEP MAC', read.vtepMAC, { mono: true }));
        if (read.vni !== null) body.appendChild(kit.field('VNI', read.vni, { mono: true }));
        body.appendChild(kit.field('Lease held by', read.subnetManager ? 'the node’s podCIDR (kube)' : 'etcd'));
        if (read.backendDataError) {
            body.appendChild(kit.field('backend-data', read.backendDataError, { tone: 'warn' }));
        }

        host.appendChild(body);

        // How full this node's own slice is.
        var pods = await model.safeList({ kind: 'pods' });
        var count = pods.filter(function (p) {
            return p.spec && p.spec.nodeName === read.name && !p.spec.hostNetwork && p.status && p.status.podIP;
        }).length;
        var v4 = read.subnets.filter(function (s) {
            return s.family === 4;
        })[0];
        if (v4) {
            var usable = Number(v4.size) - 2;
            host.appendChild(
                kit.field('Pods here', count + ' of about ' + usable + ' usable addresses', {
                    tone: usable > 0 && count / usable > 0.85 ? 'warn' : '',
                })
            );
        } else {
            host.appendChild(kit.field('Pods here', String(count)));
        }

        resize();
    }

    function resize() {
        if (k8sdockside.resize) k8sdockside.resize(document.body.scrollHeight + 12);
    }
})();
