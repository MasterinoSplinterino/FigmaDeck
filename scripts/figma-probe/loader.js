// Minimal base64 + raw-DEFLATE decoder (after zlib's puff.c) used to fit the probe bundle into
// the 50 000-character limit of the Figma MCP runtime. Inflates __PACKED__ and evaluates it.
var __fdInflate = function (d) {
  var p = 0, b = 0, bc = 0, out = [];
  function bits(n) { while (bc < n) { b |= d[p++] << bc; bc += 8; } var v = b & ((1 << n) - 1); b >>>= n; bc -= n; return v; }
  function build(lens, n) {
    var cnt = new Uint16Array(16), sym = new Uint16Array(n), offs = new Uint16Array(16), i;
    for (i = 0; i < n; i++) cnt[lens[i]]++;
    cnt[0] = 0;
    for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + cnt[i - 1];
    for (i = 0; i < n; i++) if (lens[i]) sym[offs[lens[i]]++] = i;
    return { c: cnt, s: sym };
  }
  function dec(t) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len < 16; len++) {
      code |= bits(1);
      var c = t.c[len];
      if (code - c < first) return t.s[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  }
  var LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  var LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  var DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  var ORD = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
  var last, type, i;
  do {
    last = bits(1); type = bits(2);
    if (type === 0) {
      b = 0; bc = 0;
      var len = d[p] | (d[p + 1] << 8); p += 4;
      for (i = 0; i < len; i++) out.push(d[p++]);
      continue;
    }
    var lt, dt;
    if (type === 1) {
      var l = new Uint8Array(288);
      for (i = 0; i < 144; i++) l[i] = 8; for (; i < 256; i++) l[i] = 9; for (; i < 280; i++) l[i] = 7; for (; i < 288; i++) l[i] = 8;
      lt = build(l, 288);
      var dl = new Uint8Array(30); for (i = 0; i < 30; i++) dl[i] = 5;
      dt = build(dl, 30);
    } else if (type === 2) {
      var hl = bits(5) + 257, hd = bits(5) + 1, hc = bits(4) + 4;
      var cl = new Uint8Array(19);
      for (i = 0; i < hc; i++) cl[ORD[i]] = bits(3);
      var ct = build(cl, 19), all = new Uint8Array(hl + hd);
      for (i = 0; i < hl + hd;) {
        var s = dec(ct);
        if (s < 16) all[i++] = s;
        else { var rep, v = 0; if (s === 16) { v = all[i - 1]; rep = 3 + bits(2); } else if (s === 17) rep = 3 + bits(3); else rep = 11 + bits(7); while (rep--) all[i++] = v; }
      }
      lt = build(all.subarray(0, hl), hl); dt = build(all.subarray(hl), hd);
    } else throw new Error('inflate: bad block');
    for (;;) {
      var sy = dec(lt);
      if (sy < 256) out.push(sy);
      else if (sy === 256) break;
      else {
        sy -= 257;
        var ln = LB[sy] + bits(LE[sy]), ds = dec(dt), dist = DB[ds] + bits(DE[ds]), st = out.length - dist;
        for (i = 0; i < ln; i++) out.push(out[st + i]);
      }
    }
  } while (!last);
  return out;
};
var __fdB64 = function (s) {
  var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', m = {}, i, o = [], bb = 0, n = 0;
  for (i = 0; i < 64; i++) m[A[i]] = i;
  for (i = 0; i < s.length; i++) { var c = m[s[i]]; if (c === undefined) continue; bb = (bb << 6) | c; n += 6; if (n >= 8) { n -= 8; o.push((bb >> n) & 255); } }
  return new Uint8Array(o);
};
var __fdSrc = (function () { var a = __fdInflate(__fdB64(__PACKED__)), s = ''; for (var i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.slice(i, i + 8192)); return s; })();
(0, eval)(__fdSrc);
