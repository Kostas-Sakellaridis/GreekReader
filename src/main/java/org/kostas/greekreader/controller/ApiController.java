package org.kostas.greekreader.controller;

import org.kostas.greekreader.service.PerseusService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class ApiController {

    private final PerseusService perseusService;

    public ApiController(PerseusService perseusService) {
        this.perseusService = perseusService;
    }

    @GetMapping(value = "/capabilities", produces = MediaType.APPLICATION_XML_VALUE)
    public String getCapabilities() {
        return perseusService.getCapabilities();
    }

    @GetMapping(value = "/reff", produces = MediaType.APPLICATION_XML_VALUE)
    public String getValidReff(@RequestParam String urn, @RequestParam(defaultValue = "1") int level) {
        return perseusService.getValidReff(urn, level);
    }

    @GetMapping(value = "/passage", produces = MediaType.APPLICATION_XML_VALUE)
    public String getPassage(@RequestParam String urn) {
        return perseusService.getPassage(urn);
    }

    @GetMapping(value = "/morph", produces = MediaType.APPLICATION_XML_VALUE)
    public String getMorphology(@RequestParam String word, @RequestParam(defaultValue = "greek") String lang) {
        return perseusService.getMorphology(word, lang);
    }

    @GetMapping(value = "/library", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> getLibrary() {
        String json = perseusService.getScaifeLibrary();
        return ResponseEntity.ok(json);
    }
}
