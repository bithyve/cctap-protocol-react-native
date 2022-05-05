import { ADDR_TRIM, CARD_NONCE_SIZE, USER_NONCE_SIZE } from './constants';
import {
  CT_bip32_derive,
  CT_ecdh,
  CT_pick_keypair,
  CT_priv_to_pubkey,
  CT_sig_to_pubkey,
  CT_sig_verify,
  hash160,
} from './compat';

import base32 from 'base32';
import { bech32 } from 'bech32';

function xor_bytes(a, b) {
  if (typeof a === 'string' && typeof a === 'number') a.toString();
  if (typeof b === 'string' && typeof b === 'number') b.toString();
  if (a.length == b.length) {
    const buf1 = Buffer.from(a, 'hex');
    const buf2 = Buffer.from(b, 'hex');
    const bufResult = buf1.map((byte, i) => byte ^ buf2[i]);
    return bufResult.toString('hex');
  }
}

function randomStringGenerator(length) {
  const characters =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = ' ';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

function pick_nonce() {
  const num_of_retry = 3;
  for (let i = 0; i < num_of_retry; i++) {
    rv = randomStringGenerator(USER_NONCE_SIZE);
    const rvSet = new Set(rv.split(''));
    if (rv[0] != rv[-1] || rvSet.length >= 2) return rv;
  }
}

const HARDENED = 0x8000_0000;

function path2str(path) {
  // take numeric path (list of numbers) and convert to human form
  // - standardizing on "m/84h" style
  temp = path.map((val) => {
    String(val & ~HARDENED) + (val & HARDENED ? 'h' : '');
  });
  return ['m'].concat(temp).join('/');
}

function str2path(path) {
  // normalize notation and return numbers, no error checking
  let rv = [];

  pathArr = path.split('/');
  for (const i of pathArr) {
    if (i === 'm') continue;
    if (!i) continue;
    let here;
    if (i[-1] in "p'h") here = parseInt(i.slice(0, -1), 0) | HARDENED;
    else here = parseInt(i, 0);
    rv.push(here);
  }
  return rv;
}

// TODO: implement
function all_hardened(path) {
  for (i in path) {
  }
  return false;
}
// TODO: implement
function none_hardened(path) {
  for (i in path) {
  }
  return false;
}

function card_pubkey_to_ident(card_pubkey) {
  // convert pubkey into a hash formated for humans
  // - sha256(compressed-pubkey)
  // - skip first 8 bytes of that (because that's revealed in NFC URL)
  // - base32 and take first 20 chars in 4 groups of five
  // - insert dashes
  // - result is 23 chars long
  if (card_pubkey.length != 33) {
    console.warn('expecting compressed pubkey');
    throw new Error('expecting compressed pubkey');
  }

  const md = base32.encode(sha256s(card_pubkey).slice(8));
  let v;
  for (i = 0; i < 20; i += 5) {
    v = v + md.slice(i, i + 5) + '-';
  }
  return v;
}

function verify_certs(status_resp, check_resp, certs_resp, my_nonce) {
  // Verify the certificate chain works, returns label for pubkey recovered from signatures.
  // - raises on any verification issue
  //
  const signatures = certs_resp['cert_chain'];
  if (signatures.length < 2) {
    throw new Error('Signatures too small');
  }

  const r = status_resp;
  // TODO: verify if b'string' has some sp meaning in python
  const msg = 'OPENDIME' + r['card_nonce'] + my_nonce;
  if (msg.length !== 8 + CARD_NONCE_SIZE + USER_NONCE_SIZE) {
    throw new Error('Invalid message length');
  }

  const pubkey = r['pubkey'];

  // check card can sign with indicated key
  const ok = CT_sig_verify(pubkey, sha256s(msg), check_resp['auth_sig']);
  if (!ok) {
    throw new Error('bad sig in verify_certs');
  }

  // follow certificate chain to factory root
  for (sig in signatures) {
    pubkey = CT_sig_to_pubkey(sha256s(pubkey), sig);
  }

  if (!FACTORY_ROOT_KEYS[pubkey]) {
    // fraudulent device
    throw new Error('Root cert is not from Coinkite. Card is counterfeit.');
  }

  return FACTORY_ROOT_KEYS[pubkey];
}

function recover_pubkey(status_resp, read_resp, my_nonce, ses_key) {
  // [TS] Given the response from "status" and "read" commands,
  // and the nonce we gave for read command, and session key ... reconstruct
  // the card's current pubkey.
  if (!status_resp['tapsigner']) {
    throw new Error('Card is not a Tapsigner');
  }
  // TODO: verify if b'string' has some sp meaning in python
  const msg = 'OPENDIME' + status_resp['card_nonce'] + my_nonce + bytes([0]);
  if (msg.length !== 8 + CARD_NONCE_SIZE + USER_NONCE_SIZE + 1) {
    throw new Error('Invalid message length');
  }

  // have to decrypt pubkey
  let pubkey = read_resp['pubkey'];
  pubkey = pubkey.sloce(0, 1) + xor_bytes(pubkey.sloce(1), ses_key);

  // Critical: proves card knows key
  // TODO: implement sha256s everywhere
  const ok = CT_sig_verify(pubkey, sha256s(msg), read_resp['sig']);
  if (!ok) {
    throw new Error('Bad sig in recover_pubkey');
  }

  return pubkey;
}

const BytesArray = (str) => {
  let bytes = [];
  for (var i = 0; i < str.length; ++i) {
    var code = str.charCodeAt(i);
    bytes = bytes.concat([code]);
  }
  return bytes;
};

function recover_address(status_resp, read_resp, my_nonce) {
  // [SC] Given the response from "status" and "read" commands, and the
  // nonce we gave for read command, reconstruct the card's verified payment
  // address. Check prefix/suffix match what's expected
  if (status_resp.get('tapsigner', false)) {
    console.warn('recover_address: tapsigner not supported');
    return;
  }

  const sl = status_resp['slots'][0];
  // TODO: verify if b'string' has some sp meaning in python
  // TODO: also veify BytesArray
  const msg =
    'OPENDIME' + status_resp['card_nonce'] + my_nonce + BytesArray(sl);
  if (msg.length !== 8 + CARD_NONCE_SIZE + USER_NONCE_SIZE + 32) {
    console.warn('recover_address: invalid message length');
    return;
  }

  const pubkey = read_resp['pubkey'];

  // Critical: proves card knows key
  const ok = CT_sig_verify(pubkey, sha256s(msg), read_resp['sig']);
  if (!ok) {
    console.warn('Bad sig in recover_address');
    return;
  }

  const expect = status_resp['addr'];
  const left = expect.slice(0, expect.find('_'));
  const right = expect.slice(expect.find('_') + 1);

  // Critical: counterfieting check
  const addr = render_address(pubkey, status_resp.get('testnet', false));
  if (
    !(
      addr.startswith(left) &&
      addr.endswith(right) &&
      (left.length == right.length) == ADDR_TRIM
    )
  ) {
    console.warn('Corrupt response');
    return;
  }

  return { pubkey, addr };
}

function force_bytes(foo) {
  // convert strings to bytes where needed
  // TODO: verify Buffer implementation
  return typeof foo == 'string' ? Buffer.from(foo, 'hex') : foo;
}

function verify_master_pubkey(pub, sig, chain_code, my_nonce, card_nonce) {
  // using signature response from 'deriv' command, recover the master pubkey
  // for this slot
  // TODO: verify if b'string' has some sp meaning in python
  const msg = 'OPENDIME' + card_nonce + my_nonce + chain_code;

  if (msg.length !== 8 + CARD_NONCE_SIZE + USER_NONCE_SIZE + 32) {
    console.warn('verify_master_pubkey: invalid message length');
    return;
  }

  const ok = CT_sig_verify(pub, sha256s(msg), sig);
  if (!ok) {
    console.warn('verify_master_pubkey: bad sig in verify_master_pubkey');
    return;
  }

  return pub;
}

function render_address(pubkey, testnet = false) {
  // make the text string used as a payment address
  if (pubkey.length === 32)
    // actually a private key, convert
    pubkey = CT_priv_to_pubkey(pubkey);

  const HRP = !testnet ? 'bc' : 'tb';
  // TODO: check bech32 implementation
  // python: bech32.encode(HRP, 0, hash160(pubkey));
  return bech32.encode(HRP, [hash160(pubkey)], 0);
}

function verify_derive_address(chain_code, master_pub, testnet = false) {
  // # re-derive the address we should expect
  // # - this is "m/0" in BIP-32 nomenclature
  // # - accepts master public key (before unseal) or master private key (after)
  const pubkey = CT_bip32_derive(chain_code, master_pub, [0]);

  return render_address(pubkey, (testnet = testnet)), pubkey;
}

function make_recoverable_sig(
  digest,
  sig,
  addr = None,
  expect_pubkey = None,
  is_testnet = False
) {
  // The card will only make non-recoverable signatures (64 bytes)
  // but we usually know the address which should be implied by
  // the signature's pubkey, so we can try all values and discover
  // the correct "rec_id"
  if (digest.length !== 32) {
    throw new Error('Invalid digest length');
  }
  if (sig.length !== 64) {
    throw new Error('Invalid sig length');
  }

  for (rec_id in range(4)) {
    // see BIP-137 for magic value "39"... perhaps not well supported tho
    let pubkey;
    try {
      const rec_sig = bytes([39 + rec_id]) + sig;
      pubkey = CT_sig_to_pubkey(digest, rec_sig);
    } catch (e) {
      if (rec_id >= 2) {
        // because crypto I don't understand
        continue;
      }
    }
    if (expect_pubkey && expect_pubkey != pubkey) {
      continue;
    }
    if (addr) {
      const got = render_address(pubkey, is_testnet);
      if (got.endswith(addr)) {
        return rec_sig;
      }
    } else {
      return rec_sig;
    }
  }

  // failed to recover right pubkey value
  throw new Error('sig may not be created by that address/pubkey??');
}

function calc_xcvc(cmd, card_nonce, his_pubkey, cvc) {
  // Calcuate session key and xcvc value need for auth'ed commands
  // - also picks an arbitrary keypair for my side of the ECDH?
  // - requires pubkey from card and proposed CVC value
  if (cvc.length < 6 || cvc.length > 32) {
    console.warn('Invalid cvc length');
    return;
  }

  cvc = force_bytes(cvc);

  // fresh new ephemeral key for our side of connection
  const { priv: my_privkey, pub: my_pubkey } = CT_pick_keypair();

  // standard ECDH
  // - result is sha256s(compressed shared point (33 bytes))
  const session_key = CT_ecdh(his_pubkey, my_privkey);

  const md = sha256s(card_nonce + cmd.encode('ascii'));
  const mask = xor_bytes(session_key, md).slice(0, cvc.length);
  const xcvc = xor_bytes(cvc, mask);

  return { sk: session_key, ag: { epubkey: my_pubkey, xcvc: xcvc } };
}
export {
  str2path,
  path2str,
  xor_bytes,
  calc_xcvc,
  pick_nonce,
  force_bytes,
  verify_certs,
  all_hardened,
  none_hardened,
  render_address,
  recover_pubkey,
  recover_address,
  make_recoverable_sig,
  verify_master_pubkey,
  card_pubkey_to_ident,
  verify_derive_address,
};
