import { ADDR_TRIM, CARD_NONCE_SIZE, USER_NONCE_SIZE } from './constants';
import {
  CT_bip32_derive,
  CT_ecdh,
  CT_pick_keypair,
  CT_priv_to_pubkey,
  CT_sig_to_pubkey,
  CT_sig_verify,
  base32Encode,
  hash160,
  sha256s,
} from './compat';

import { FACTORY_ROOT_KEYS } from './constants';
import { bech32 } from 'bech32';
import { randomBytes } from 'crypto';
import xor from 'buffer-xor';

function tou8(
  buf: Buffer | Uint8Array | number[] | null
): Uint8Array | undefined {
  if (!buf) return undefined;
  if (buf.constructor.name === 'Uint8Array' || buf.constructor === Uint8Array) {
    return buf as Uint8Array;
  }
  if (typeof buf === 'string') {
    buf = Buffer.from(buf);
  }
  var a = new Uint8Array(buf.length);
  for (var i = 0; i < buf.length; i++) {
    a[i] = buf[i];
  }
  return a;
}

function xor_bytes(a: Buffer, b: Buffer): Buffer {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new Error('Type mismatch: Expected buffers at xor_bytes');
  }
  if (a.length !== b.length) {
    throw new Error('Length mismatch: Expected same lengths at xor_bytes');
  }
  return Buffer.from(xor(a, b));
}

function pick_nonce(): Buffer {
  const num_of_retry = 3;
  for (let i = 0; i < num_of_retry; i++) {
    const rv = randomBytes(USER_NONCE_SIZE);
    const rvSet = new Set(rv);
    if (rv[0] != rv[-1] || rvSet.size >= 2) return rv;
  }
}

const HARDENED: any = 0x80000000;

function path_component_in_range(num: number): boolean {
  // cannot be less than 0
  // cannot be more than (2 ** 31) - 1
  if (0 <= num < HARDENED) {
    return true;
  }
  return false;
}

function path2str(path: number[]): string {
  const temp = [];
  for (var i = 0; i < path.length; i += 1) {
    var item = path[i];
    temp.push((item & ~HARDENED).toString() + (item & HARDENED ? 'h' : ''));
  }
  return ['m', ...temp].join('/');
}

function str2path(path: string): number[] {
  // normalize notation and return numbers, limited error checking
  let rv: number[] = [];
  let here;
  const splitArr = path.split('/');
  for (let i in splitArr) {
    const item = splitArr[i];
    if (item == 'm') {
      continue;
    }
    if (!item) {
      // trailing or duplicated slashes
      continue;
    }

    if ("'phHP".includes(item[item.length - 1])) {
      if (item.length < 2) {
        throw new Error(`Malformed bip32 path component: ${item}`);
      }
      const num = Number.parseInt(item.slice(0, -1));
      if (!path_component_in_range(num)) {
        throw new Error(`Hardened path component out of range: ${item}`);
      }
      here = (num | HARDENED) >>> 0;
    } else {
      here = Number.parseInt(item);
      if (!path_component_in_range(here)) {
        // cannot be less than 0
        // cannot be more than (2 ** 31) - 1
        throw new Error(`Non-hardened path component out of range: ${item}`);
      }
    }
    rv = rv.concat(here);
  }

  return rv;
}

function all(itr: any[]): boolean {
  return itr.every(item => !!item);
}

function any(itr: any[]): boolean {
  return itr.some(item => !!item);
}

//  predicates for numeric paths. stop giggling
function all_hardened(path: number[]): boolean {
  return all(path.map(item => !!(item & HARDENED)));
}
function none_hardened(path: number[]): boolean {
  return !any(path.map(item => !!(item & HARDENED)));
}

function card_pubkey_to_ident(card_pubkey: Buffer): string {
  // convert pubkey into a hash formated for humans
  // - sha256(compressed-pubkey)
  // - skip first 8 bytes of that (because that's revealed in NFC URL)
  // - base32 and take first 20 chars in 4 groups of five
  // - insert dashes
  // - result is 23 chars long
  if (card_pubkey.length != 33) {
    throw new Error('expecting compressed pubkey');
  }
  const md = base32Encode(Buffer.from(sha256s(card_pubkey).slice(8)));
  let v = '';
  for (let i = 0; i < 20; i += 5) {
    v += md.slice(i, i + 5) + '-';
  }
  return v.slice(0, -1);
}

function verify_certs(
  status_resp: { ver: string; card_nonce: Buffer; pubkey: Buffer },
  check_resp: { auth_sig: Buffer },
  certs_resp: { cert_chain: Buffer[] },
  my_nonce: Buffer,
  slot_pubkey: string | Buffer = null
): Buffer {
  // # Verify the certificate chain works, returns label for pubkey recovered from signatures.
  // # - raises on any verification issue
  if (status_resp['ver'] == '0.9.0') {
    // # compat with v0.9.0 cards which never attest to the pubkey
    slot_pubkey = null;
  }

  return verify_certs_ll(
    status_resp['card_nonce'],
    status_resp['pubkey'],
    my_nonce,
    certs_resp['cert_chain'],
    check_resp['auth_sig'],
    slot_pubkey
  );
}

function verify_certs_ll(
  card_nonce: Buffer,
  card_pubkey: Buffer,
  my_nonce: Buffer,
  cert_chain: Buffer[],
  signature: Buffer,
  slot_pubkey: string | Buffer = null
): Buffer {
  // Lower-level version with just the facts coming in...
  if (cert_chain.length < 2) {
    throw new Error('Missing certs');
  }
  let msg = Buffer.concat([Buffer.from('OPENDIME'), card_nonce, my_nonce]);
  if (msg.length !== 8 + CARD_NONCE_SIZE + USER_NONCE_SIZE) {
    throw new Error('Invalid message length');
  }
  slot_pubkey = slot_pubkey
    ? Buffer.from(slot_pubkey as string, 'hex')
    : slot_pubkey;
  if (slot_pubkey) {
    // in v1.0.0+ SATSCARD, the pubkey of the sealed slot (if any) is included here
    if (slot_pubkey.length !== 33) {
      throw new Error('Invalid slot pubkey length');
    }
    msg = Buffer.concat([msg, slot_pubkey as Buffer]);
  }

  // check card can and does sign with indicated key
  const ok = CT_sig_verify(
    signature,
    tou8(sha256s(msg)) as Uint8Array,
    card_pubkey
  );
  if (!ok) {
    throw new Error('bad sig in when verifying certificates');
  }
  let pubkey = card_pubkey;
  // follow certificate chain to factory root
  for (let i in cert_chain) {
    const signature = cert_chain[i];
    pubkey = CT_sig_to_pubkey(tou8(sha256s(pubkey)) as Uint8Array, signature);
  }

  if (Buffer.compare(Buffer.from(pubkey), FACTORY_ROOT_KEYS[0])) {
    // fraudulent device
    throw new Error('Root cert is not from Coinkite. Card is counterfeit.');
  }
  console.log('Root cert is from Coinkite. Card is legit.');
  return pubkey;
}

function recover_pubkey(
  status_resp: { is_tapsigner: boolean; card_nonce: Buffer },
  read_resp: { pubkey: Buffer; sig: Buffer },
  my_nonce: Buffer,
  ses_key: Buffer
): Buffer {
  // [TS] Given the response from "status" and "read" commands,
  // and the nonce we gave for read command, and session key ... reconstruct
  // the card's current pubkey.
  if (!status_resp['is_tapsigner']) {
    throw new Error('Card is not a Tapsigner');
  }
  const msg = Buffer.concat([
    Buffer.from('OPENDIME'),
    status_resp['card_nonce'],
    my_nonce,
    Buffer.from([0]),
  ]);
  if (msg.length !== 8 + CARD_NONCE_SIZE + USER_NONCE_SIZE + 1) {
    throw new Error('Invalid message length');
  }

  // have to decrypt pubkey
  let pubkey = read_resp['pubkey'];
  pubkey = Buffer.concat([
    pubkey.slice(0, 1),
    xor_bytes(pubkey.slice(1), ses_key),
  ]);

  // Critical: proves card knows key
  const ok = CT_sig_verify(
    pubkey,
    tou8(sha256s(msg)) as Uint8Array,
    read_resp['sig']
  );
  if (!ok) {
    throw new Error('Bad sig in recover_pubkey');
  }

  return pubkey;
}

function recover_address(
  status_resp: {
    is_tapsigner: boolean;
    card_nonce: Buffer;
    slots: any[];
    addr: string;
  },
  read_resp: { pubkey: Buffer; sig: Buffer },
  my_nonce: Buffer
): { pubkey: Buffer; addr: string } {
  // [SC] Given the response from "status" and "read" commands, and the
  // nonce we gave for read command, reconstruct the card's verified payment
  // address. Check prefix/suffix match what's expected
  if (status_resp['is_tapsigner']) {
    throw new Error('recover_address: tapsigner not supported');
  }
  const sl = status_resp['slots'][0];
  const msg = Buffer.concat([
    Buffer.from('OPENDIME'),
    status_resp['card_nonce'],
    my_nonce,
    Buffer.from([sl]),
  ]);

  if (msg.length !== 8 + CARD_NONCE_SIZE + USER_NONCE_SIZE + 1) {
    throw new Error('recover_address: invalid message length');
  }

  const pubkey = read_resp['pubkey'];

  // Critical: proves card knows key
  const ok = CT_sig_verify(read_resp['sig'], Buffer.from(sha256s(msg)), pubkey);
  if (!ok) {
    throw new Error('Bad sig in recover_address');
  }

  const expect = status_resp['addr'];

  const left = expect.slice(0, expect.indexOf('_'));
  const right = expect.slice(expect.lastIndexOf('_') + 1);

  // Critical: counterfieting check
  const addr = render_address(pubkey, false);

  if (
    !(
      addr.startsWith(left) &&
      addr.endsWith(right) &&
      left.length === right.length &&
      left.length === ADDR_TRIM
    )
  ) {
    throw new Error('Corrupt response');
  }

  return { pubkey, addr };
}

function force_bytes(foo: string) {
  // convert strings to bytes where needed
  return typeof foo === 'string' ? Buffer.from(foo) : foo;
}

function verify_master_pubkey(
  pub: Buffer,
  sig: Buffer,
  chain_code: Buffer,
  my_nonce: Buffer,
  card_nonce: Buffer
): Buffer {
  // using signature response from 'deriv' command, recover the master pubkey
  // for this slot
  const msg = Buffer.concat([
    Buffer.from('OPENDIME'),
    card_nonce,
    my_nonce,
    chain_code,
  ]);

  if (msg.length !== 8 + CARD_NONCE_SIZE + USER_NONCE_SIZE + 32) {
    throw new Error('verify_master_pubkey: invalid message length');
  }

  const ok = CT_sig_verify(sig, Buffer.from(sha256s(msg)), pub);
  if (!ok) {
    throw new Error('verify_master_pubkey: bad sig in verify_master_pubkey');
  }

  return pub;
}

function render_address(pubkey: Buffer, testnet = false): string {
  // make the text string used as a payment address
  if (pubkey.length === 32)
    // actually a private key, convert
    pubkey = CT_priv_to_pubkey(pubkey);
  const HRP = !testnet ? 'bc' : 'tb';
  const words = bech32.toWords(hash160(pubkey));
  return bech32.encode(HRP, [0].concat(words));
}

function verify_derive_address(
  chain_code: Buffer,
  master_pub: Buffer,
  testnet = false
): { derived_addr: string; pubkey: Buffer } {
  // # re-derive the address we should expect
  // # - this is "m/0" in BIP-32 nomenclature
  // # - accepts master public key (before unseal) or master private key (after)
  const pubkey = CT_bip32_derive(chain_code, master_pub, [0]);

  return { derived_addr: render_address(pubkey, testnet), pubkey };
}

function make_recoverable_sig(
  digest: Buffer,
  sig: Buffer,
  addr?: string | null,
  expect_pubkey?: Buffer | null,
  is_testnet: boolean = false
): Buffer {
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

  for (var rec_id = 0; rec_id < 4; rec_id++) {
    // see BIP-137 for magic value "39"... perhaps not well supported tho
    let pubkey;
    let rec_sig;
    try {
      rec_sig = Buffer.concat([Buffer.from([39 + rec_id]), sig]);
      pubkey = CT_sig_to_pubkey(digest, rec_sig);
    } catch (e) {
      if (rec_id >= 2) {
        // because crypto I don't understand
        continue;
      }
    }
    //  Buffer.compare returns 0 if the buffers are equal
    if (expect_pubkey && Buffer.compare(expect_pubkey, Buffer.from(pubkey))) {
      continue;
    }
    if (addr) {
      const got = render_address(pubkey, is_testnet);
      if (got.endsWith(addr)) {
        return rec_sig;
      }
    } else {
      return rec_sig;
    }
  }

  // failed to recover right pubkey value
  throw new Error('sig may not be created by that address/pubkey??');
}

function calc_xcvc(
  cmd: string,
  card_nonce: Buffer,
  his_pubkey: Buffer,
  cvc: string | Buffer
): {
  sk: Buffer;
  ag: {
    epubkey: Buffer;
    xcvc: Buffer;
  };
} {
  // Calcuate session key and xcvc value need for auth'ed commands
  // - also picks an arbitrary keypair for my side of the ECDH?
  // - requires pubkey from card and proposed CVC value
  if (cvc.length < 6 || cvc.length > 32) {
    throw new Error('Invalid cvc length');
  }
  cvc = force_bytes(cvc as string);
  // fresh new ephemeral key for our side of connection
  const { priv: my_privkey, pub: my_pubkey } = CT_pick_keypair();
  // standard ECDH
  // - result is sha256(compressed shared point (33 bytes))
  const session_key = Buffer.from(
    CT_ecdh(his_pubkey, tou8(my_privkey) as Uint8Array)
  );
  const message = Buffer.concat([card_nonce, Buffer.from(cmd)]);
  const md = sha256s(message);
  const mask = xor_bytes(session_key, Buffer.from(md)).slice(0, cvc.length);
  const xcvc = xor_bytes(cvc, mask);
  return { sk: session_key, ag: { epubkey: Buffer.from(my_pubkey), xcvc } };
}

export {
  tou8,
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
