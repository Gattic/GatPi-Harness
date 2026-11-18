# Kinematics mini-reference

For directly externally meshing ideal spur gears A/B with tooth counts `N_A`, `N_B`, angular velocities satisfy `omega_B = -omega_A * N_A / N_B`. The angle relation is `theta_B(t) = offset_B - (N_A/N_B) * (theta_A(t)-offset_A)` unless a different internal mesh or transmission path changes the sign. This is an idealized center-distance model; involute tooth geometry and load conditions still require analysis.

For a single-start lead screw, displacement in the screw axis is `travel = turns * pitch`; for multistart screws use **lead = starts × pitch**, with direction set by handedness and coordinate convention.

For periodic systems, test `state(t0) == state(t0+period)` for all cyclic parameters within a chosen tolerance and verify first derivative continuity when seamless loop motion is required. Mechanical escapements advance discretely, and ideal sine motion should not be misrepresented as real escapement dynamics.

At minimum sample extrema, assembly endpoints, imminent contacts and near-clearance times, plus an adaptive sample around suspected collision intervals. Screenshots cannot establish clearance in occluded 3D geometry.
