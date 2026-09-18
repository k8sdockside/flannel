# Flannel for K8s Dockside

A plugin for the [K8s Dockside](https://github.com/rogerwesterbo/k8sdockside)
desktop app that shows [Flannel](https://github.com/flannel-io/flannel) as what
it is: one subnet per node, joined into a flat pod network. Plain HTML and
script, no build step. Needs **K8s Dockside 0.0.27 or newer**.

## What it shows

Flannel has no custom resources, no controller and no API of its own. Everything
it knows lives in three places, and this plugin reads exactly those:

- the **ConfigMap** (`net-conf.json`) — the cluster network, backend, port, MTU;
- each **Node's `spec.podCIDR`** — the slice flanneld leased to that node;
- each **Node's `flannel.alpha.coreos.com/*` annotations** — how peers reach it.

From that:

- **Overview** — whether Flannel is healthy, how this network is built (backend,
  port, VNI, MTU, nftables or iptables, the networks), the cluster network drawn
  to scale, what needs attention, Flannel's own pods node by node, and its
  recent events.
- **Subnet map** — the whole cluster network to scale, each node's lease sized
  and placed where it actually falls, filled by how much of that lease is in
  use. Click a slice to pin it against the table of leases below.
- **Backend & peers** — what the configured backend is, what it needs of the
  network underneath it, and every node with the endpoint, VTEP MAC and VNI
  other nodes use to reach it. Nodes sharing a VTEP MAC are called out.
- **Panels** on Nodes (the slice it holds, how it is reached, how full it is)
  and Pods (which node subnet the address came from — or that the pod is on the
  host network and uses none).

It looks for the daemonset and ConfigMap in both `kube-flannel` and
`kube-system`, under the names Flannel has used across releases, so it works on
kubeadm, Talos and the upstream manifests alike.

### What it calls out

Rather than leaving them to be spotted:

- a node with **no lease** — flanneld has not started there, so it has no route;
- a node with **no podCIDR**, which with `--kube-subnet-mgr` means no lease;
- a lease that falls **outside** the configured network, so its pods are not
  routable;
- **overlapping** leases between two nodes;
- nodes whose **backend disagrees** with `net-conf.json` — a backend changed in
  the ConfigMap only takes effect where flanneld has restarted, and a
  half-converted cluster drops traffic between the two halves;
- two nodes claiming the **same VTEP MAC**;
- for **host-gw**, node endpoints spread across more than one subnet, which that
  backend cannot route between.

## Installing

**Settings → Plugins → From a repository** with:

```
https://github.com/rogerwesterbo/k8sdockside-flannel.git
```

## What it reads, and what it changes

It reads **Nodes**, **Pods**, **DaemonSets**, **ConfigMaps** and **Events**.

It **changes nothing**. The manifest declares `"write": false`, so the app will
not offer it a way to, and it asks for no network, no registries and no
services.

The one ConfigMap it reads by name is Flannel's own (`kube-flannel-cfg`); it
does not read Secrets, and the app would refuse if it tried.

## Charts

There are none. flanneld only exposes Prometheus metrics when started with
`--metrics-listen`, which the upstream manifests do not set, so there is no
query this plugin could ship that would work on a default install. Everything
the pages show is read from the API server instead.

## Developing

```sh
# what CI runs: loads the plugin exactly as the app does
go run github.com/rogerwesterbo/k8sdockside/cmd/plugincheck@main .
```

The pages are plain classic scripts — no build, no bundler, nothing generated.
Edit a file in `ui/` and reopen its tab in the app to see the change; press
**Reload** in **Settings → Plugins** after changing `plugin.json`.

`ui/model.js` holds everything that is not drawing: address maths, reading the
config and the node annotations, and deciding what counts as a problem. It is
free of DOM calls on purpose, so it can be exercised on its own.

## Licence

[MIT](LICENSE)
