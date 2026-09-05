> crowd-rapp@0.1.0 analyse
> node eval/analyse.mjs


reference-2026-09-05T03-19-18-994Z.jsonl   326 ticks

DECISION RATE
  model decided             326/326  (100.0%)
  no usable output, held    0
    model                 225
    neighbour-blocked     101

DRIFT FROM REFERENCE   (317 reliable ticks, 9 excluded)
                 mean     p50      p95      max
  |Δ fan_center|   2.70°    1.67°    7.09°   12.75°
  |Δ tilt|         0.38°    0.22°    1.40°    3.86°

  signed mean Δ fan_center  -1.40°   (centred)

WHERE IT GOES WRONG
  near  (<60 m)      n=  34   mean   3.61°   max   7.44°
  mid   (60-120 m)   n= 120   mean   4.14°   max  12.75°
  far   (>120 m)     n= 163   mean   1.44°   max  10.00°
  peak on edge       —
  peak centred       n= 303   mean   2.68°   max  12.75°

CLAMP
  fired on 102/326 ticks  <-- model going out of bounds
    tick 23: asked 3°/13.8° -> rewritten by -13°/-0.7°
    tick 25: asked -10.1°/11.7° -> rewritten by 0.1°/1.4°
    tick 62: asked -2°/7.7° -> rewritten by 0°/0.6°
    tick 64: asked -2°/7.7° -> rewritten by 0°/0.6°
    tick 65: asked -2°/7.7° -> rewritten by 0°/0.6°

EXCLUDED (reference known-unreliable)
  near_field       9

RETRAINING SET
  50 worst ticks -> traces\reference-2026-09-05T03-19-18-994Z.retrain.jsonl
  worst delta 12.75° at tick 164
    profile   [-72, -56, -51, -53, -65]
    reference 2.75°   model -10°

  These are cases the model already fails. Add them to the next training run,
  and add them to the pre-eval fixed set so the next version cannot regress.

(.venv311)
siree@MalikWin MINGW64 /c/BeamMeUpQwen (main)
$
