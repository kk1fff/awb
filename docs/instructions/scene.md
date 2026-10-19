# Scene objects, primitives, camera, and lighting

Use `list_objects` and `inspect_object` to understand the current scene. Use `create_object`, `update_object`, and `delete_object` to edit it. Creation requires a name and a type: `box`, `sphere`, `cylinder`, `cone`, `plane`, or `asset`. For an asset, search the local catalog with `search_assets` and pass its `assetId`. The server assigns stable object IDs; use IDs for later edits. `GET /api/tools` or the MCP input schema provides exact fields and validation.

Coordinates are right-handed with Y up. `position` is the object's center in world units. `rotation` is an Euler XYZ triple in **radians**. `dimensions` are full local width, height, and depth before `scale`; both dimensions and scale are positive triples. A box is centered on its position. A sphere can become an ellipsoid by changing dimensions or scale. Cylinders and cones run along local Y, with X and Z diameters. To use a cylinder as a car wheel, rotate it around an axis so its local Y axis points along the axle. A plane lies in local XY and has no thickness; its depth is ignored. A ground plane can use `dimensions: [12,10,1]` and `rotation: [-1.5707963267948966,0,0]`. A standing wall can use an unrotated plane; use a box when thickness matters.

Primitive defaults are position and rotation `[0,0,0]`, dimensions and scale `[1,1,1]`, color `#7a9d82`, roughness `0.86`, metalness `0`, and visibility `true`. `color` is six-digit hex. A model asset preserves embedded materials and defaults to its catalog bounds. Names need not be unique.

Object **names** can contain spaces and are limited to 120 characters; the restrictive `assetId` pattern applies to catalog IDs, not object names. Primitives do not support Boolean cuts. Placing a door or window asset against one solid wall does not make an opening: build the wall from separate box segments around the opening, or leave the opening visible in a cutaway design.

Use `set_camera` for the canonical view used in screenshots. The default is orthographic, position `[12,12,12]`, target `[0,0,0]`, vertical size `15`; perspective uses a vertical FOV in degrees. Browser orbiting is temporary until **Use current view** is selected. Use `set_lighting` for ambient and directional light, shadow softness, environment, and background. Search assets before selecting an environment or material preset. Render and inspect after composition changes; see the `evidence` guide.

For complete field limits, API envelopes, and errors, read the `tools` guide.
