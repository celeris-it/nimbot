import { mount } from "svelte";
import App from "./App.svelte";
import { applyAppearance, readAppearance } from "./appearance.js";
import { initializeLanguage } from "./i18n/language.js";
import "./panel.css";

initializeLanguage();

const initialAppearance = readAppearance();
applyAppearance(initialAppearance);
mount(App, {
  target: document.getElementById("app")!,
  props: { initialAppearance },
});
