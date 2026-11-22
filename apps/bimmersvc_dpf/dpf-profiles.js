'use strict';

const B47 = {
  engine: 'B47',
  dde: 'D83BX7C0',
  address: 0x12,
  verified: false,
  readings: {
    soot:     {did:0x44BE, bytes:2, factor:0.01525902},
    ash:      {did:0x44BD, bytes:2, factor:0.01525902},
    pressure: {did:0x44ED, bytes:2, factor:0.04577707, offset:-1000},
    temp:     {did:0x4502, bytes:2, factor:0.03128099, offset:-50},
    distance: {did:0x44BF, bytes:4, factor:0.001}
  }
};

const B57 = {
  engine: 'B57',
  vehicle: 'G05 X5 30d 48V',
  address: 0x12,
  verified: false,
  dde: null,
  readings: {
    soot: null,
    ash: null,
    pressure: null,
    temp: null,
    distance: null,
    regeneration: null
  }
};

module.exports = {B47, B57};
