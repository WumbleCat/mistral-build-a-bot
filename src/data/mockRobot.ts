import type { AssemblyData } from '../types';

/**
 * Realistic mock data for a four-wheel Arduino robot car.
 * The first three steps match the example schema from the project brief;
 * extra steps/parts demonstrate that the studio supports arbitrary input.
 * Treat as an example schema, not verified construction instructions.
 */
export const mockRobot: AssemblyData = {
  robot_name: 'Four-Wheel Robot Car',
  description: 'A simple four-wheel Arduino-powered robot',
  illustrative: true,
  parts: [
    { id: 'chassis', name: 'Robot chassis', quantity: 1 },
    { id: 'motor', name: 'DC motor', quantity: 4 },
    { id: 'wheel', name: 'Robot wheel', quantity: 4 },
    { id: 'controller', name: 'Arduino controller', quantity: 1 },
    { id: 'battery', name: 'Battery pack', quantity: 1 },
    { id: 'wire', name: 'Jumper wire', quantity: 4 },
    { id: 'screw', name: 'M3 screw', quantity: 8 },
  ],
  steps: [
    {
      id: 'step-1',
      number: 1,
      title: 'Prepare the chassis',
      instruction: 'Position the chassis on a flat surface.',
      narration: 'First, prepare the robot chassis.',
      component_ids: ['chassis'],
      installed_components: ['chassis'],
      visual_prompt: 'Show the chassis on its own.',
    },
    {
      id: 'step-2',
      number: 2,
      title: 'Attach the motors',
      instruction: 'Position the motors at their designated mounting points.',
      narration: 'Next, attach the four DC motors to the chassis.',
      component_ids: ['motor'],
      installed_components: ['chassis', 'motor'],
      visual_prompt: 'Show the four motors being attached to the chassis.',
    },
    {
      id: 'step-3',
      number: 3,
      title: 'Attach the wheels',
      instruction: 'Connect each wheel to the appropriate motor axle.',
      narration: 'Now attach each wheel to its corresponding motor axle.',
      component_ids: ['wheel'],
      installed_components: ['chassis', 'motor', 'wheel'],
      visual_prompt: 'Show all four wheels being attached.',
    },
    {
      id: 'step-4',
      number: 4,
      title: 'Mount the controller',
      instruction: 'Mount the Arduino controller in the centre of the chassis and secure it with four M3 screws.',
      narration: 'Mount the Arduino controller in the centre of the chassis, and secure it with four screws.',
      component_ids: ['controller', 'screw'],
      installed_components: ['chassis', 'motor', 'wheel', 'controller', 'screw'],
      visual_prompt: 'Show the Arduino controller mounted on top of the chassis with screws.',
    },
    {
      id: 'step-5',
      number: 5,
      title: 'Install the battery pack',
      instruction: 'Place the battery pack behind the controller and strap it to the chassis.',
      narration: 'Place the battery pack behind the controller and fix it to the chassis.',
      component_ids: ['battery'],
      installed_components: ['chassis', 'motor', 'wheel', 'controller', 'screw', 'battery'],
      visual_prompt: 'Show the battery pack installed at the rear of the chassis.',
    },
    {
      id: 'step-6',
      number: 6,
      title: 'Connect the wires',
      instruction: 'Connect one jumper wire from the controller to each motor, matching the polarity markings.',
      narration: 'Finally, connect one wire from the controller to each motor, matching the polarity markings.',
      component_ids: ['wire'],
      installed_components: ['chassis', 'motor', 'wheel', 'controller', 'screw', 'battery', 'wire'],
      visual_prompt: 'Show the four wires routed from the controller to the motors.',
    },
  ],
};
