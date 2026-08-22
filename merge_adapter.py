import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE = "Qwen/Qwen2.5-0.5B-Instruct"
ADAPTER = "./beam-lora"
OUT = "./beam-merged"

print("loading base model...")
base = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float16)
print("loading adapter and merging...")
merged = PeftModel.from_pretrained(base, ADAPTER).merge_and_unload()
print(f"saving merged model to {OUT} ...")
merged.save_pretrained(OUT)
AutoTokenizer.from_pretrained(BASE).save_pretrained(OUT)
print("DONE. merged model is in", OUT)
