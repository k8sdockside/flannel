// The drawing kit the pages share: elements, icons, the network bar a subnet
// map is built from, chips, stat rows and the problem list.
//
// Everything a cluster supplies reaches the page as text, never as markup. The
// frame is sandboxed, but a page that let a node's name run as HTML would still
// be a page that lets a node's name run as HTML.

(function () {
    'use strict';

    // el('div', { class: 'x' }, child, child) -> HTMLElement.
    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (key) {
                var value = attrs[key];
                if (value === null || value === undefined || value === false) return;
                if (key === 'class') node.className = value;
                else if (key === 'text') node.textContent = value;
                else if (key === 'style') node.setAttribute('style', value);
                else if (key.slice(0, 2) === 'on' && typeof value === 'function') node[key.toLowerCase()] = value;
                else node.setAttribute(key, value === true ? '' : value);
            });
        }
        var rest = Array.prototype.slice.call(arguments, 2);
        rest.forEach(function add(child) {
            if (child === null || child === undefined || child === false) return;
            if (Array.isArray(child)) {
                child.forEach(add);
                return;
            }
            node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
        });
        return node;
    }

    function clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
        return node;
    }

    // ------------------------------------------------------------------ pieces

    // chip is a small labelled value: the unit the overview is built from.
    function chip(label, value, tone) {
        return el(
            'span',
            { class: 'chip' + (tone ? ' chip-' + tone : '') },
            el('span', { class: 'chip-label', text: label }),
            el('span', { class: 'chip-value', text: value === null || value === undefined || value === '' ? '—' : String(value) })
        );
    }

    // stat is a bigger number with a caption under it.
    function stat(value, caption, tone) {
        return el(
            'div',
            { class: 'stat' + (tone ? ' stat-' + tone : '') },
            el('div', { class: 'stat-value', text: String(value) }),
            el('div', { class: 'stat-caption', text: caption })
        );
    }

    // field is a label/value row inside a panel.
    function field(label, value, opts) {
        var options = opts || {};
        var valueNode = el('span', {
            class: 'field-value' + (options.mono ? ' mono' : '') + (options.tone ? ' tone-' + options.tone : ''),
            text: value === null || value === undefined || value === '' ? '—' : String(value),
        });
        return el('div', { class: 'field' }, el('span', { class: 'field-label', text: label }), valueNode);
    }

    // ------------------------------------------------------------- network bar
    //
    // One cluster network drawn to scale, with each node's leased subnet placed
    // where it actually falls inside it. Slices are positioned as percentages of
    // the whole, so a /24 in a /16 is 0.39% wide and a /24 in a /22 is a quarter
    // — the picture stays honest about how much of the network is handed out.

    // MIN_SLICE_PERCENT keeps a slice visible when it is a rounding error wide.
    // The number under it is still the true size; this is about being clickable.
    var MIN_SLICE_PERCENT = 0.6;

    function networkBar(network, slices, opts) {
        var options = opts || {};
        var track = el('div', { class: 'bar-track' });

        slices.forEach(function (slice) {
            if (slice.offset === null || slice.size === null) return;
            var width = Math.max(slice.size * 100, MIN_SLICE_PERCENT);
            var left = Math.min(slice.offset * 100, 100 - width);
            var node = el('div', {
                class: 'bar-slice' + (slice.tone ? ' bar-slice-' + slice.tone : '') + (slice.selected ? ' is-selected' : ''),
                style: 'left:' + left.toFixed(4) + '%;width:' + width.toFixed(4) + '%',
                title: slice.title || '',
                tabindex: options.interactive ? '0' : null,
                role: options.interactive ? 'button' : null,
            });
            if (options.interactive && slice.onSelect) {
                node.onclick = slice.onSelect;
                node.onkeydown = function (ev) {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        slice.onSelect();
                    }
                };
            }
            // A fill inside the slice shows how much of *that* subnet is used.
            if (typeof slice.fill === 'number' && slice.fill > 0) {
                node.appendChild(
                    el('div', {
                        class: 'bar-slice-fill',
                        style: 'height:' + Math.min(100, Math.max(2, slice.fill * 100)).toFixed(2) + '%',
                    })
                );
            }
            track.appendChild(node);
        });

        return el(
            'div',
            { class: 'bar' },
            el(
                'div',
                { class: 'bar-head' },
                el('span', { class: 'bar-title mono', text: network.text }),
                el('span', { class: 'bar-sub', text: options.caption || describeSize(network) })
            ),
            track,
            el(
                'div',
                { class: 'bar-scale' },
                el('span', { class: 'mono', text: firstAddress(network) }),
                el('span', { class: 'mono', text: lastAddress(network) })
            )
        );
    }

    // describeSize puts a readable count of addresses on a network.
    function describeSize(cidr) {
        if (!cidr) return '';
        if (cidr.family === 6) return 'IPv6 · /' + cidr.prefix;
        var n = Number(cidr.size);
        return 'IPv4 · ' + n.toLocaleString() + ' addresses';
    }

    function firstAddress(cidr) {
        return formatAddress(cidr.base, cidr.family);
    }

    function lastAddress(cidr) {
        return formatAddress(cidr.end, cidr.family);
    }

    // formatAddress renders a BigInt back to dotted-quad or compressed IPv6.
    function formatAddress(value, family) {
        if (family === 4) {
            var v = value;
            var parts = [];
            for (var i = 3; i >= 0; i--) parts.push(Number((v >> BigInt(i * 8)) & 0xffn));
            return parts.join('.');
        }
        var groups = [];
        for (var g = 7; g >= 0; g--) groups.push(Number((value >> BigInt(g * 16)) & 0xffffn).toString(16));
        return compressIPv6(groups);
    }

    // compressIPv6 collapses the longest run of zero groups into "::".
    function compressIPv6(groups) {
        var bestStart = -1;
        var bestLen = 0;
        var runStart = -1;
        var runLen = 0;
        for (var i = 0; i < 8; i++) {
            if (groups[i] === '0') {
                if (runStart < 0) runStart = i;
                runLen++;
                if (runLen > bestLen) {
                    bestLen = runLen;
                    bestStart = runStart;
                }
            } else {
                runStart = -1;
                runLen = 0;
            }
        }
        if (bestLen < 2) return groups.join(':');
        var head = groups.slice(0, bestStart).join(':');
        var tail = groups.slice(bestStart + bestLen).join(':');
        return head + '::' + tail;
    }

    // ---------------------------------------------------------------- problems

    // problemList renders what findProblems found, worst first.
    function problemList(problems) {
        var order = { error: 0, warn: 1, info: 2 };
        var sorted = problems.slice().sort(function (a, b) {
            return (order[a.tone] || 9) - (order[b.tone] || 9);
        });
        var list = el('ul', { class: 'problems' });
        sorted.forEach(function (p) {
            list.appendChild(
                el(
                    'li',
                    { class: 'problem problem-' + (p.tone || 'info') },
                    el('div', { class: 'problem-title', text: p.title }),
                    p.detail ? el('div', { class: 'problem-detail', text: p.detail }) : null
                )
            );
        });
        return list;
    }

    // verdict is the one-line answer at the top of the overview.
    function verdict(tone, headline, detail) {
        return el(
            'div',
            { class: 'verdict verdict-' + tone },
            el('div', { class: 'verdict-dot' }),
            el(
                'div',
                { class: 'verdict-body' },
                el('div', { class: 'verdict-headline', text: headline }),
                detail ? el('div', { class: 'verdict-detail', text: detail }) : null
            )
        );
    }

    function section(title, subtitle, body) {
        return el(
            'section',
            { class: 'panel' },
            el(
                'header',
                { class: 'panel-head' },
                el('h2', { class: 'panel-title', text: title }),
                subtitle ? el('p', { class: 'panel-sub', text: subtitle }) : null
            ),
            body
        );
    }

    function empty(message) {
        return el('p', { class: 'empty', text: message });
    }

    // showError puts a failure where the user can read it, as a sentence.
    function showError(err) {
        var banner = document.getElementById('error');
        if (!banner) return;
        banner.textContent = err && err.message ? err.message : String(err);
        banner.hidden = false;
    }

    // relative renders a timestamp as "4m ago".
    function relative(iso) {
        if (!iso) return '';
        var then = Date.parse(iso);
        if (!isFinite(then)) return '';
        var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
        if (secs < 60) return secs + 's ago';
        if (secs < 3600) return Math.round(secs / 60) + 'm ago';
        if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
        return Math.round(secs / 86400) + 'd ago';
    }

    window.Flannel = window.Flannel || {};
    window.Flannel.kit = {
        el: el,
        clear: clear,
        chip: chip,
        stat: stat,
        field: field,
        networkBar: networkBar,
        describeSize: describeSize,
        formatAddress: formatAddress,
        firstAddress: firstAddress,
        lastAddress: lastAddress,
        problemList: problemList,
        verdict: verdict,
        section: section,
        empty: empty,
        showError: showError,
        relative: relative,
    };
})();
