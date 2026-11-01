// Just enough of the RPG Maker 2000/2003 "LCF" format to read a few facts
// from RPG_RT.ldb: which engine the game was made with, and the names of the
// title screen / system graphics (used for library thumbnails).

function readBer(u8, pos) {
  let value = 0;
  let byte;
  let guard = 0;
  do {
    if (pos.p >= u8.length) throw new Error('Unexpected end of data');
    byte = u8[pos.p++];
    value = value * 128 + (byte & 0x7f);
  } while (byte & 0x80 && ++guard < 6);
  return value;
}

/**
 * @param {Uint8Array} u8 contents of RPG_RT.ldb
 * @returns {{engine: number, titleName: Uint8Array|null, systemName: Uint8Array|null} | null}
 *          null when the data is not an RPG Maker database
 */
export function readDatabaseInfo(u8) {
  try {
    const pos = { p: 0 };
    const headerLen = readBer(u8, pos);
    const header = String.fromCharCode(...u8.subarray(pos.p, pos.p + headerLen));
    pos.p += headerLen;
    if (header !== 'LcfDataBase') return null;

    const info = { engine: 2000, titleName: null, systemName: null };
    while (pos.p < u8.length) {
      const id = readBer(u8, pos);
      if (id === 0) break;
      const size = readBer(u8, pos);
      const start = pos.p;
      const end = Math.min(start + size, u8.length);

      if (id === 0x16) {
        // rpg::System
        const sp = { p: start };
        while (sp.p < end) {
          const fid = readBer(u8, sp);
          if (fid === 0) break;
          const fsize = readBer(u8, sp);
          const fstart = sp.p;
          if (fid === 0x0a) {
            const ldbId = readBer(u8, { p: fstart });
            if (ldbId === 2003) info.engine = 2003;
          } else if (fid === 0x11) {
            info.titleName = u8.slice(fstart, fstart + fsize);
          } else if (fid === 0x13) {
            info.systemName = u8.slice(fstart, fstart + fsize);
          }
          sp.p = fstart + fsize;
        }
      }
      pos.p = start + size;
    }
    return info;
  } catch {
    return null;
  }
}
