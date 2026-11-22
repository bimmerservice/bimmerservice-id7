
'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');

mgu.run({
  async start(ctx) {

    // Read vehicle data without changing ECU settings
    const car = new Car(ctx, ['rpm', 'speed']);

    ctx.loop('MAIN', 10, () => {

      const t = ctx.theme();
      const d = car.data();

      const rpm = G.isNum(d.rpm) ? d.rpm : 0;
      const speed = G.isNum(d.speed) ? d.speed : 0;

      const cv = ctx.canvas(1600, 520).clear(t.bg);

      // Main page
      G.frame(cv, t, ['BimmerService'], 0,
        [d.demo && { text: 'DEMO' }]);

      // Left RPM gauge
      G.radial(cv, t, 435, 285, 165, {
        value: rpm,
        min: 0,
        max: 5500,
        label: 'RPM',
        ticks: 11
      });

      // Right speed gauge
      G.radial(cv, t, 1165, 285, 165, {
        value: speed,
        min: 0,
        max: 260,
        label: 'KM/H',
        ticks: 13
      });

      // BimmerService branding
      cv.text(
        'BIMMERSERVICE',
        800, 205, 39, t.text,
        { align: 'center', font: 'bold' }
      );

      cv.text(
        'DIGITAL COCKPIT',
        800, 250, 23, t.accent,
        { align: 'center', font: 'label' }
      );

      cv.text(
        'BMW ID7',
        800, 305, 27, t.dim,
        { align: 'center', font: 'bold' }
      );

      cv.text(
        'VERSION 0.1',
        800, 365, 19, t.dim,
        { align: 'center', font: 'label' }
      );

      return ctx.ui.image('MAIN_GFX', cv);
    });
  }
});
