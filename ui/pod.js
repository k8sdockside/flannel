// The Flannel panel on a Pod: which node subnet this address came out of.
//
// Flannel does not record anything per pod — the pod's address is simply taken
// from the subnet leased to the node it runs on. Saying that plainly is the
// useful thing, including when it is not true (a host-network pod shares the
// node's address and never touches the overlay).

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
        var pod = await k8sdockside.object();
        var host = kit.clear(document.getElementById('body'));
        var spec = pod.spec || {};
        var status = pod.status || {};

        if (spec.hostNetwork) {
            host.appendChild(
                kit.verdict(
                    'ok',
                    'This pod is on the host network',
                    'It shares ' + (spec.nodeName || 'its node') + '’s addresses and does not use a Flannel subnet at all.'
                )
            );
            resize();
            return;
        }

        if (!status.podIP) {
            host.appendChild(kit.verdict('warn', 'This pod has no address yet', 'Flannel assigns one through the CNI when the sandbox starts.'));
            resize();
            return;
        }

        var body = el('div', {});
        body.appendChild(kit.field('Pod address', status.podIP, { mono: true }));

        var others = (status.podIPs || [])
            .map(function (e) {
                return e.ip;
            })
            .filter(function (ip) {
                return ip && ip !== status.podIP;
            });
        others.forEach(function (ip) {
            body.appendChild(kit.field('Also', ip, { mono: true }));
        });

        if (!spec.nodeName) {
            body.appendChild(kit.field('Node', 'not scheduled', { tone: 'warn' }));
            host.appendChild(body);
            resize();
            return;
        }

        var node = null;
        try {
            node = await k8sdockside.get({ kind: 'nodes', name: spec.nodeName });
        } catch (err) {
            // Falls through to the "could not read" line below.
        }

        body.appendChild(kit.field('Node', spec.nodeName));

        if (!node) {
            body.appendChild(kit.field('Node subnet', 'could not read the node', { tone: 'warn' }));
            host.appendChild(body);
            resize();
            return;
        }

        var read = model.readNode(node);
        var holder = read.subnets.filter(function (s) {
            return model.addressIn(s, status.podIP);
        })[0];

        if (holder) {
            body.appendChild(kit.field('From the node’s subnet', holder.text, { mono: true, tone: 'ok' }));
            body.appendChild(kit.field('Which spans', kit.firstAddress(holder) + ' – ' + kit.lastAddress(holder), { mono: true }));
        } else if (read.subnets.length) {
            // Worth flagging: the address did not come from this node's lease,
            // which means the lease moved or another CNI handed it out.
            body.appendChild(
                kit.field(
                    'From the node’s subnet',
                    'no — ' + spec.nodeName + ' holds ' + read.subnets.map(function (s) { return s.text; }).join(', '),
                    { mono: true, tone: 'warn' }
                )
            );
        } else {
            body.appendChild(kit.field('Node subnet', 'the node holds no lease', { tone: 'error' }));
        }

        if (read.backendType) {
            body.appendChild(
                kit.field(
                    'Leaves the node by',
                    read.backendType + (read.publicIP ? ' from ' + read.publicIP : '')
                )
            );
        }

        host.appendChild(body);
        resize();
    }

    function resize() {
        if (k8sdockside.resize) k8sdockside.resize(document.body.scrollHeight + 12);
    }
})();
